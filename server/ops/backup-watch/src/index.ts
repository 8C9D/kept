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

export default {
  async scheduled(_controller: unknown, env: Env): Promise<void> {
    await watchBackups(env, new Date());
  },
};
