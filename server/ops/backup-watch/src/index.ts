import {
  checkBackups,
  formatAlert,
  formatCheckFailedAlert,
  formatHealthyLine,
  parseMaxAgeHours,
  type AlertText,
  type BucketLister,
} from "./freshness.js";

/**
 * The Worker around `freshness.ts`: once a day, list the bucket, and either log a
 * line or send an email. See README.md.
 *
 * ⚠ The daily tick is a Durable Object alarm, not a cron trigger. The Free plan
 * allows five cron triggers per account and other projects hold all five. An alarm
 * needs no slot, re-arms itself, and survives deploys. It does need one first arm,
 * which is `POST /check` below; `README.md` says so.
 *
 * Mail goes through the structured `send()` on the `send_email` binding, which is
 * the form Cloudflare's docs recommend as of October 2026, so there is no raw MIME,
 * no `EmailMessage` from `cloudflare:email` and no Message-ID to build. Sending to a
 * verified destination works with only Email Routing enabled, from an address on a
 * routing domain. Local `wrangler dev` simulates the binding and sends nothing.
 *
 * ⚠ Types are declared here rather than taken from `@cloudflare/workers-types`,
 * which this repository does not depend on. These two interfaces are the whole of
 * what the Worker touches, and that keeps the handler testable from `tests/unit`.
 */
export interface Env {
  BACKUPS: BucketLister;
  WATCH: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(request: Request): Promise<Response> };
  };
  /** A secret. Without it, every HTTP request is a 404. */
  WATCH_TOKEN?: string;
  ALERT: {
    send(message: {
      to: string;
      from: string;
      subject: string;
      text: string;
    }): Promise<{ messageId: string }>;
  };
  /** A secret. This repository is public, so the address never appears in it. */
  ALERT_TO?: string;
  ALERT_FROM?: string;
  MAX_AGE_HOURS?: string;
}

/**
 * Checked first and on every run, not when an alert is due. A healthy backup and a
 * Worker with no recipient look the same until the night the alert has nowhere to
 * go, so a forgotten `wrangler secret put` fails every run where Cloudflare shows it.
 */
function addressing(env: Env): { to: string; from: string } {
  if (env.ALERT_TO === undefined || env.ALERT_TO === "") {
    throw new Error("ALERT_TO is not set. Set it with: wrangler secret put ALERT_TO");
  }
  if (env.ALERT_FROM === undefined || env.ALERT_FROM === "") {
    throw new Error("ALERT_FROM is not set. It belongs in [vars] in wrangler.toml.");
  }
  return { to: env.ALERT_TO, from: env.ALERT_FROM };
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function sendAlert(env: Env, alert: AlertText): Promise<void> {
  const sent = await env.ALERT.send({ ...addressing(env), ...alert });
  console.log(`Kept backup alert sent: ${alert.subject} (${sent.messageId})`);
}

/**
 * Exported for the tests. A check that throws tries to say so by email and then
 * rethrows the check's own error, whatever happened to the email: the rethrow is
 * what marks the invocation failed in Cloudflare, and the alert failing as well must
 * not replace the reason. A send that fails on a stale backup throws too, for the
 * same reason. The one thing that may not happen is a quiet exit.
 */
export async function watchBackups(env: Env, now: Date): Promise<void> {
  addressing(env);

  let report;
  try {
    report = await checkBackups(env.BACKUPS, now, parseMaxAgeHours(env.MAX_AGE_HOURS));
  } catch (error) {
    try {
      await sendAlert(env, formatCheckFailedAlert(reasonOf(error)));
    } catch (sendError) {
      console.error(`Kept backup alert could not be sent: ${reasonOf(sendError)}`);
    }
    throw error;
  }

  if (report.healthy) {
    console.log(formatHealthyLine(report));
    return;
  }
  await sendAlert(env, formatAlert(report));
}

/** The next 12:00 UTC strictly after `now`, so that the tick cannot drift. */
export function nextRunAt(now: Date): number {
  const noon = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12);
  return noon > now.getTime() ? noon : noon + 24 * 60 * 60 * 1000;
}

interface AlarmState {
  storage: {
    setAlarm(scheduledTime: number): Promise<void>;
    getAlarm(): Promise<number | null>;
  };
}

/**
 * Holds the alarm. A plain class rather than `DurableObject` from
 * `cloudflare:workers`, which would stop `tests/unit` importing this file.
 *
 * ⚠ It re-arms BEFORE it checks, and `alarm()` does not rethrow. This is a
 * dead man's switch: a check that threw and took the next tick with it would be
 * the same silence it exists to end. `watchBackups` has already tried to send the
 * failure by email and the error is logged where Cloudflare keeps it.
 */
export class BackupWatch {
  constructor(
    private readonly state: AlarmState,
    private readonly env: Env,
  ) {}

  async alarm(): Promise<void> {
    const now = new Date();
    await this.state.storage.setAlarm(nextRunAt(now));
    try {
      await watchBackups(this.env, now);
    } catch (error) {
      console.error(`Kept backup watch failed: ${reasonOf(error)}`);
    }
  }

  /** Arms the alarm and checks now. `?test=1` also sends a mail, to prove delivery. */
  async fetch(request: Request): Promise<Response> {
    const now = new Date();
    await this.state.storage.setAlarm(nextRunAt(now));
    await watchBackups(this.env, now);
    if (new URL(request.url).searchParams.get("test") === "1") {
      await sendAlert(this.env, {
        subject: "Kept backup watch: test",
        text: "This is a test of the backup watch. No action is needed.",
      });
    }
    const next = await this.state.storage.getAlarm();
    return Response.json({ nextRunAt: next === null ? null : new Date(next).toISOString() });
  }
}

/** Compared as digests, so the comparison says nothing about the token's bytes. */
async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

export default {
  /**
   * The one route exists to arm the alarm the first time and to check on demand.
   * Everything else, and everything without the token, is a plain 404: the
   * workers.dev address is public and has nothing to say to a stranger.
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const token = env.WATCH_TOKEN;
    const presented = request.headers.get("x-watch-token");
    const allowed =
      request.method === "POST" &&
      new URL(request.url).pathname === "/check" &&
      token !== undefined &&
      token !== "" &&
      presented !== null &&
      (await digest(presented)) === (await digest(token));
    if (!allowed) {
      return new Response("Not found", { status: 404 });
    }
    return env.WATCH.get(env.WATCH.idFromName("kept-backups")).fetch(request);
  },
};
