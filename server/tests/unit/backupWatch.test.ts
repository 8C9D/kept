import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_AGE_HOURS,
  PAGE_LIMIT,
  assessNewest,
  checkBackups,
  formatAlert,
  formatCheckFailedAlert,
  newestObject,
  parseMaxAgeHours,
  type BucketLister,
  type ListedObject,
  type ListedPage,
} from "../../ops/backup-watch/src/freshness.js";
import worker, {
  BackupWatch,
  nextRunAt,
  watchBackups,
  type Env,
} from "../../ops/backup-watch/src/index.js";

const NOW = new Date("2026-10-31T12:00:00.000Z");
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);
const object = (key: string, ageHours: number, size = 180_000): ListedObject => ({
  key,
  size,
  uploaded: hoursAgo(ageHours),
});

/** An R2 bucket for listing: lexicographic, paged, and strict about `limit`. */
function bucketOf(objects: ListedObject[], pageSize = PAGE_LIMIT) {
  const sorted = [...objects].sort((a, b) => (a.key < b.key ? -1 : 1));
  const calls: Array<{ prefix: string; limit: number; cursor?: string }> = [];
  const bucket: BucketLister = {
    async list(options) {
      calls.push(options);
      const matching = sorted.filter(({ key }) => key.startsWith(options.prefix));
      const start = Number(options.cursor ?? 0);
      const size = Math.min(pageSize, options.limit);
      const page = matching.slice(start, start + size);
      const truncated = start + size < matching.length;
      return {
        objects: page,
        truncated,
        ...(truncated ? { cursor: String(start + size) } : {}),
      };
    },
  };
  return { bucket, calls };
}

const healthy = [
  object("pg/kept-20261031-060000.dump", 6),
  object("manifests/kept-20261031-060000.tsv", 6),
];

describe("parseMaxAgeHours", () => {
  it("defaults when unset or empty, and reads a number", () => {
    expect(parseMaxAgeHours(undefined)).toBe(DEFAULT_MAX_AGE_HOURS);
    expect(parseMaxAgeHours("")).toBe(DEFAULT_MAX_AGE_HOURS);
    expect(parseMaxAgeHours("72")).toBe(72);
    expect(parseMaxAgeHours("0.5")).toBe(0.5);
  });

  it("refuses by name what would make every comparison false", () => {
    for (const value of ["two days", "NaN", "0", "-1", "Infinity"]) {
      expect(() => parseMaxAgeHours(value), value).toThrow(/MAX_AGE_HOURS/);
    }
  });
});

describe("newestObject", () => {
  it("is undefined for an empty prefix", async () => {
    expect(await newestObject(bucketOf([]).bucket, "pg/")).toBeUndefined();
  });

  it("finds the newest on the last page, and asks with a limit", async () => {
    const objects = Array.from({ length: 25 }, (_, day) =>
      object(`pg/kept-202610${String(day + 1).padStart(2, "0")}-060000.dump`, (31 - day) * 24),
    );
    const { bucket, calls } = bucketOf(objects, 10);
    expect((await newestObject(bucket, "pg/"))?.key).toBe("pg/kept-20261025-060000.dump");
    expect(calls).toHaveLength(3);
    expect(calls.every(({ limit }) => limit === PAGE_LIMIT)).toBe(true);
    expect(calls.map(({ cursor }) => cursor)).toEqual([undefined, "10", "20"]);
  });

  it("finds the newest on the first page, where lexical order would hide it", async () => {
    const { bucket } = bucketOf(
      [object("pg/a-newest.dump", 1), object("pg/m.dump", 100), object("pg/z.dump", 200)],
      1,
    );
    expect((await newestObject(bucket, "pg/"))?.key).toBe("pg/a-newest.dump");
  });

  it("keeps going on a short page that says it is truncated", async () => {
    const pages: ListedPage[] = [
      { objects: [], truncated: true, cursor: "a" },
      { objects: [object("pg/one.dump", 5)], truncated: true, cursor: "b" },
      { objects: [object("pg/two.dump", 1)], truncated: false },
    ];
    const bucket: BucketLister = { list: async () => pages.shift()! };
    expect((await newestObject(bucket, "pg/"))?.key).toBe("pg/two.dump");
  });

  it("throws rather than reporting a partial listing as the whole", async () => {
    const noCursor: BucketLister = {
      list: async () => ({ objects: [object("pg/old.dump", 500)], truncated: true }),
    };
    await expect(newestObject(noCursor, "pg/")).rejects.toThrow(/truncated/);

    const sameCursor: BucketLister = {
      list: async () => ({ objects: [], truncated: true, cursor: "again" }),
    };
    await expect(newestObject(sameCursor, "pg/")).rejects.toThrow(/truncated/);
  });

  it("counts a hand-run key by when it was uploaded, not how it sorts", async () => {
    const hand = "pg/kept-20261002-manual-231052.dump";
    const { bucket } = bucketOf([object("pg/kept-20261031-060000.dump", 20), object(hand, 2)]);
    expect((await newestObject(bucket, "pg/"))?.key).toBe(hand);
  });

  it("ignores nothing under the prefix, whatever it is called", async () => {
    const { bucket } = bucketOf([object("pg/not-a-dump-at-all", 1), object("pg/kept.dump", 90)]);
    expect((await newestObject(bucket, "pg/"))?.key).toBe("pg/not-a-dump-at-all");
  });
});

describe("assessNewest", () => {
  const dump = { label: "dump", prefix: "pg/" };

  it("is healthy at exactly the limit and stale just past it", () => {
    expect(assessNewest(dump, object("k", 48), NOW, 48).problems).toEqual([]);
    const stale = assessNewest(dump, object("k", 48.1), NOW, 48);
    expect(stale.problems).toEqual(["the newest dump is 48.1 hours old, over the 48-hour limit"]);
  });

  it("calls an empty prefix a problem", () => {
    expect(assessNewest(dump, undefined, NOW, 48).problems).toEqual(["no dump at all under pg/"]);
  });

  it("calls a fresh zero-byte newest a problem, and says both when it is also stale", () => {
    expect(assessNewest(dump, object("k", 1, 0), NOW, 48).problems).toEqual([
      "the newest dump is 0 bytes",
    ]);
    expect(assessNewest(dump, object("k", 90, 0), NOW, 48).problems).toHaveLength(2);
  });
});

describe("checkBackups", () => {
  it("is healthy with a fresh dump and a fresh manifest", async () => {
    const report = await checkBackups(bucketOf(healthy).bucket, NOW, 48);
    expect(report.healthy).toBe(true);
    expect(report.findings.map(({ label }) => label)).toEqual(["dump", "manifest"]);
  });

  it("alerts on a fresh dump over a stale manifest, the image leg failing", async () => {
    const { bucket } = bucketOf([
      object("pg/kept-20261031-060000.dump", 6),
      object("manifests/kept-20261025-060000.tsv", 150),
    ]);
    const report = await checkBackups(bucket, NOW, 48);
    expect(report.healthy).toBe(false);
    expect(report.findings[0]?.problems).toEqual([]);
    expect(report.findings[1]?.problems[0]).toContain("newest manifest is 150.0 hours old");
  });

  it("alerts when there are no dumps at all", async () => {
    const { bucket } = bucketOf([object("manifests/kept-20261031-060000.tsv", 6)]);
    const report = await checkBackups(bucket, NOW, 48);
    expect(report.healthy).toBe(false);
    expect(report.findings[0]?.problems).toEqual(["no dump at all under pg/"]);
  });

  it("alerts on a zero-byte newest dump with a good older one behind it", async () => {
    const { bucket } = bucketOf([
      object("pg/kept-20261030-060000.dump", 30),
      object("pg/kept-20261031-060000.dump", 6, 0),
      object("manifests/kept-20261031-060000.tsv", 6),
    ]);
    const report = await checkBackups(bucket, NOW, 48);
    expect(report.healthy).toBe(false);
    expect(report.findings[0]?.problems).toEqual(["the newest dump is 0 bytes"]);
  });

  it("is not satisfied by images arriving: only the two prefixes count", async () => {
    const { bucket, calls } = bucketOf([object("images/mirror/x.jpg", 1)]);
    const report = await checkBackups(bucket, NOW, 48);
    expect(report.healthy).toBe(false);
    expect(new Set(calls.map(({ prefix }) => prefix))).toEqual(new Set(["pg/", "manifests/"]));
  });
});

describe("the alert's text", () => {
  it("states the age and the newest key, and what to run", async () => {
    const { bucket } = bucketOf([
      object("pg/kept-20261028-060000.dump", 78, 12_345),
      object("manifests/kept-20261028-060000.tsv", 78),
    ]);
    const { subject, text } = formatAlert(await checkBackups(bucket, NOW, 48));
    expect(subject).toContain("78.0 hours old");
    expect(subject).not.toContain("\n");
    expect(text).toContain("pg/kept-20261028-060000.dump, 78.0 hours old, 12345 bytes");
    expect(text).toContain("manifests/kept-20261028-060000.tsv");
    expect(text).toContain("npm run db:backup-status");
  });

  it("says what failed when the check itself could not run", () => {
    const { subject, text } = formatCheckFailedAlert("Error: R2 said no");
    expect(subject).toContain("could not be checked");
    expect(text).toContain("Error: R2 said no");
    expect(text).toContain("npm run db:backup-status");
  });
});

describe("the Worker", () => {
  let log: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const envWith = (
    objects: ListedObject[],
    overrides: Partial<Env> = {},
  ): Env & { sent: Array<Record<string, string>> } => {
    const sent: Array<Record<string, string>> = [];
    return {
      sent,
      BACKUPS: bucketOf(objects).bucket,
      WATCH: {
        idFromName: (name) => name,
        get: () => ({ fetch: async () => new Response("unused") }),
      },
      ALERT: {
        async send(message) {
          sent.push(message);
          return { messageId: "id" };
        },
      },
      ALERT_TO: "owner@example.com",
      ALERT_FROM: "alerts@example.com",
      ...overrides,
    };
  };

  it("logs one line and sends nothing when the backup is fresh", async () => {
    const env = envWith(healthy);
    await watchBackups(env, NOW);
    expect(env.sent).toEqual([]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain("pg/kept-20261031-060000.dump");
  });

  it("sends one email when it is stale, to the secret, from the var", async () => {
    const env = envWith([object("pg/kept-20261020-060000.dump", 300)]);
    await watchBackups(env, NOW);
    expect(env.sent).toHaveLength(1);
    expect(env.sent[0]).toMatchObject({
      to: "owner@example.com",
      from: "alerts@example.com",
    });
    expect(env.sent[0]?.text).toContain("pg/kept-20261020-060000.dump");
    expect(env.sent[0]?.text).toContain("npm run db:backup-status");
  });

  it("honours MAX_AGE_HOURS", async () => {
    const fine = envWith(healthy, { MAX_AGE_HOURS: "72" });
    await watchBackups(fine, NOW);
    expect(fine.sent).toEqual([]);

    const tight = envWith(healthy, { MAX_AGE_HOURS: "2" });
    await watchBackups(tight, NOW);
    expect(tight.sent).toHaveLength(1);
  });

  it("alerts and rethrows when R2 throws, so it shows in Cloudflare", async () => {
    const failure = new Error("R2 said no");
    const env = envWith([], { BACKUPS: { list: () => Promise.reject(failure) } });
    await expect(watchBackups(env, NOW)).rejects.toBe(failure);
    expect(env.sent).toHaveLength(1);
    expect(env.sent[0]?.subject).toContain("could not be checked");
    expect(env.sent[0]?.text).toContain("R2 said no");
  });

  it("rethrows R2's error, not the alert's, when the alert fails as well", async () => {
    const failure = new Error("R2 said no");
    const env = envWith([], {
      BACKUPS: { list: () => Promise.reject(failure) },
      ALERT: { send: () => Promise.reject(new Error("mail is down")) },
    });
    await expect(watchBackups(env, NOW)).rejects.toBe(failure);
    expect(error.mock.calls[0]?.[0]).toContain("mail is down");
  });

  it("does not stay quiet when a stale alert cannot be sent", async () => {
    const env = envWith([], { ALERT: { send: () => Promise.reject(new Error("mail is down")) } });
    await expect(watchBackups(env, NOW)).rejects.toThrow("mail is down");
  });

  it("treats a bad MAX_AGE_HOURS as a failed check: alerted, and rethrown", async () => {
    const env = envWith(healthy, { MAX_AGE_HOURS: "two days" });
    await expect(watchBackups(env, NOW)).rejects.toThrow(/MAX_AGE_HOURS/);
    expect(env.sent).toHaveLength(1);
  });

  it("fails every run with no recipient, a healthy backup included", async () => {
    const env = envWith(healthy, { ALERT_TO: undefined });
    await expect(watchBackups(env, NOW)).rejects.toThrow(/wrangler secret put ALERT_TO/);
  });

  describe("the alarm that ticks it", () => {
    const stateWith = () => {
      const alarm = { at: null as number | null };
      return {
        alarm,
        state: {
          storage: {
            setAlarm: async (at: number) => {
              alarm.at = at;
            },
            getAlarm: async () => alarm.at,
          },
        },
      };
    };

    it("always aims at the next 12:00 UTC", () => {
      expect(new Date(nextRunAt(new Date("2026-10-31T11:59:59Z"))).toISOString()).toBe(
        "2026-10-31T12:00:00.000Z",
      );
      expect(new Date(nextRunAt(new Date("2026-10-31T12:00:00Z"))).toISOString()).toBe(
        "2026-11-01T12:00:00.000Z",
      );
    });

    it("checks when it fires, and alerts", async () => {
      const env = envWith([]);
      const { state } = stateWith();
      await new BackupWatch(state, env).alarm();
      expect(env.sent).toHaveLength(1);
      expect(env.sent[0]?.text).toContain("no dump at all under pg/");
    });

    it("keeps ticking when a check throws: losing the next tick is the failure itself", async () => {
      const env = envWith(healthy, { ALERT_TO: undefined });
      const { state, alarm } = stateWith();
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});

      await expect(new BackupWatch(state, env).alarm()).resolves.toBeUndefined();

      expect(alarm.at).toBeGreaterThan(Date.now());
      expect(logged).toHaveBeenCalled();
      logged.mockRestore();
    });

    it("arms on the first request, says when, and sends a test mail only if asked", async () => {
      const env = envWith(healthy);
      const { state, alarm } = stateWith();
      const watch = new BackupWatch(state, env);

      const armed = await watch.fetch(new Request("https://watch/check", { method: "POST" }));
      expect(alarm.at).not.toBeNull();
      expect(((await armed.json()) as { nextRunAt: string }).nextRunAt).toMatch(/T12:00:00/);
      expect(env.sent).toHaveLength(0);

      await watch.fetch(new Request("https://watch/check?test=1", { method: "POST" }));
      expect(env.sent).toHaveLength(1);
    });
  });

  describe("the route", () => {
    const forward = () => {
      const seen: Request[] = [];
      return {
        seen,
        WATCH: {
          idFromName: (name: string) => name,
          get: () => ({
            fetch: async (request: Request) => {
              seen.push(request);
              return new Response("ok");
            },
          }),
        },
      };
    };
    const post = (path: string, token?: string) =>
      new Request(`https://watch${path}`, {
        method: "POST",
        ...(token !== undefined && { headers: { "x-watch-token": token } }),
      });

    it("is a 404 to everyone without the token, or with no token configured", async () => {
      const { seen, WATCH } = forward();
      const env = envWith(healthy, { WATCH, WATCH_TOKEN: "right" });
      expect((await worker.fetch(post("/check"), env)).status).toBe(404);
      expect((await worker.fetch(post("/check", "wrong"), env)).status).toBe(404);
      expect((await worker.fetch(post("/other", "right"), env)).status).toBe(404);
      expect(
        (await worker.fetch(new Request("https://watch/check", { method: "GET" }), env)).status,
      ).toBe(404);
      const unset = envWith(healthy, { WATCH, WATCH_TOKEN: undefined });
      expect((await worker.fetch(post("/check", "anything"), unset)).status).toBe(404);
      expect(seen).toEqual([]);
    });

    it("reaches the alarm with the token", async () => {
      const { seen, WATCH } = forward();
      const env = envWith(healthy, { WATCH, WATCH_TOKEN: "right" });
      expect((await worker.fetch(post("/check", "right"), env)).status).toBe(200);
      expect(seen).toHaveLength(1);
    });
  });
});
