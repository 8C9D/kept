import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { describeFailure, runTool } from "./backupTools.js";

/**
 * A real restore, every run, into a Postgres cluster that exists for one
 * minute: §10B's "an untested backup is an assumption" made into a step rather
 * than a drill somebody has to remember.
 *
 * A private cluster rather than a scratch database on the local server, because
 * the job has to work on a laptop at 02:00 with nothing else running, and
 * because a restored copy of the tax records then has exactly one lifetime and
 * one directory.
 *
 * ⚠ The restored data is the real data. The directory is mkdtemp's 700, the
 * server listens on loopback only behind a random scram password, and it is
 * deleted however the run ends. Nothing about it is meant to outlive `work`.
 */

const CLUSTER_USER = "kept_backup";
const RESTORE_DATABASE = "kept_restore";

/**
 * Judgements, not measurements, written down as such. The clusters here start
 * in about a second; these exist so that a wedged tool ends the run instead of
 * hanging it forever, and a restore gets as long as a dump does.
 */
const INITDB_TIMEOUT_MS = 2 * 60_000;
const PG_CTL_WAIT_SECONDS = 60;
const PG_CTL_TIMEOUT_MS = (PG_CTL_WAIT_SECONDS + 30) * 1000;
const RESTORE_TIMEOUT_MS = 30 * 60_000;

/**
 * ⚠ The difference between this job working from a terminal and working at all.
 * launchd hands a job no locale, and with none in its environment Postgres on
 * macOS refuses to start: `FATAL: postmaster became multithreaded during
 * startup`, with the hint `Set the LC_ALL environment variable to a valid
 * locale`. Measured under `env -i`, and invisible from any shell that has LANG
 * set, which is every shell a test or a hand run would be started from. Every
 * scheduled run would have failed here while every run anyone watched passed.
 *
 * `C` to match the cluster's own `--locale=C`. tests/integration/backup.test.ts
 * runs the real job in a stripped environment to keep this honest.
 */
function clusterEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, LC_ALL: "C" };
}

export interface ThrowawayCluster {
  port: number;
  password: string;
  /** Connection URL for the empty database a dump restores into. */
  url: string;
}

/**
 * Runs `work` against a fresh cluster, then stops it and deletes it.
 *
 * Teardown problems go to `onTeardownFailure` rather than being thrown from the
 * finally block, where they would replace whatever `work` returned or threw. A
 * cluster that would not stop is a problem to report, not a reason to discard a
 * verified restore.
 */
export async function withThrowawayCluster<T>(
  onTeardownFailure: (message: string) => void,
  work: (cluster: ThrowawayCluster) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "kept-backup-cluster-"));
  const dataDir = join(directory, "data");
  const disarm = armEmergencyTeardown(directory, dataDir);
  try {
    const password = randomBytes(24).toString("hex");
    const passwordFile = join(directory, "pwfile");
    await writeFile(passwordFile, password, { mode: 0o600 });
    await runTool(
      "initdb",
      [
        "-D",
        dataDir,
        `--username=${CLUSTER_USER}`,
        `--pwfile=${passwordFile}`,
        "--auth=scram-sha-256",
        // Stated rather than inherited, because what initdb would otherwise
        // pick depends on the environment it happens to run in, and a restore
        // proves nothing about UTF8 text if the cluster is not UTF8.
        "--encoding=UTF8",
        "--locale=C",
        "--no-sync",
      ],
      { timeoutMs: INITDB_TIMEOUT_MS, stderr: "forward", env: clusterEnvironment() },
    );

    const port = await freePort();
    await appendFile(join(dataDir, "postgresql.conf"), clusterSettings(port));
    await startCluster(dataDir, join(directory, "server.log"));

    const cluster: ThrowawayCluster = {
      port,
      password,
      // sslmode stated so that a PGSSLMODE in the environment cannot make the
      // client demand TLS of a server that has none.
      url: clusterUrl(port, password),
    };
    await createRestoreDatabase(cluster);
    return await work(cluster);
  } finally {
    disarm();
    await tearDown(directory, dataDir, onTeardownFailure);
  }
}

/**
 * pg_restore into the cluster. `--no-owner --no-privileges` because Neon's
 * roles do not exist here; `--exit-on-error` because the default is to press on
 * past a failed statement and exit 1 at the end of a half-restored database.
 *
 * ⚠ Its stderr is withheld. A failing COPY prints the row it choked on, and
 * that row is a receipt; the failure message says how to get the text by hand,
 * from the dump the run keeps, at a terminal rather than in a log.
 */
export async function restoreDump(cluster: ThrowawayCluster, dumpPath: string): Promise<void> {
  await runTool(
    "pg_restore",
    [
      "--host=127.0.0.1",
      `--port=${cluster.port}`,
      `--username=${CLUSTER_USER}`,
      `--dbname=${RESTORE_DATABASE}`,
      "--no-owner",
      "--no-privileges",
      "--exit-on-error",
      dumpPath,
    ],
    {
      timeoutMs: RESTORE_TIMEOUT_MS,
      stderr: "withhold",
      env: { ...process.env, PGPASSWORD: cluster.password },
    },
  );
}

/**
 * ⚠ `unix_socket_directories = ''` is not tidiness. macOS limits a socket path
 * to 103 bytes and $TMPDIR alone spends most of them, so a socket inside this
 * directory stops the server from starting at all (measured). TCP on loopback
 * needs no path, and `pg_ctl -w` watches postmaster.pid rather than connecting.
 *
 * The durability settings are off because there is nothing to protect: the
 * files are deleted at the end of the minute they exist for.
 */
function clusterSettings(port: number): string {
  return `
listen_addresses = '127.0.0.1'
port = ${port}
unix_socket_directories = ''
max_connections = 10
fsync = off
synchronous_commit = off
full_page_writes = off
autovacuum = off
`;
}

async function startCluster(dataDir: string, logPath: string): Promise<void> {
  try {
    await runTool(
      "pg_ctl",
      ["start", "-D", dataDir, "-w", "-t", String(PG_CTL_WAIT_SECONDS), "-l", logPath],
      { timeoutMs: PG_CTL_TIMEOUT_MS, stderr: "forward", env: clusterEnvironment() },
    );
  } catch (error) {
    // The server's own log is the only record of why, and it is about to be
    // deleted with the directory. Nothing has been restored yet, so it holds
    // startup messages and no row can be in it.
    const log = await readFile(logPath, "utf8").catch(() => "");
    if (log !== "") {
      process.stderr.write(log.endsWith("\n") ? log : `${log}\n`);
    }
    throw error;
  }
}

async function createRestoreDatabase(cluster: ThrowawayCluster): Promise<void> {
  const client = new Client({
    host: "127.0.0.1",
    port: cluster.port,
    user: CLUSTER_USER,
    password: cluster.password,
    database: "postgres",
    ssl: false,
  });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE ${RESTORE_DATABASE}`);
  } finally {
    await client.end();
  }
}

/**
 * A port nothing is using at this instant. There is a moment between closing
 * this socket and the server binding it; losing that race fails `pg_ctl start`
 * loudly, which costs one night's run and is not worth the machinery to avoid.
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : undefined;
      server.close(() => {
        if (port === undefined) {
          reject(new Error("Could not find a free port for the throwaway cluster"));
        } else {
          resolve(port);
        }
      });
    });
  });
}

/**
 * postmaster.pid rather than a "did we start it" flag: `pg_ctl start -w` giving
 * up on a slow server does not mean the server stopped trying, and that server
 * is the one most in need of stopping.
 */
async function tearDown(
  directory: string,
  dataDir: string,
  onTeardownFailure: (message: string) => void,
): Promise<void> {
  if (existsSync(join(dataDir, "postmaster.pid"))) {
    try {
      await stopCluster(dataDir, "fast");
    } catch (error) {
      onTeardownFailure(`throwaway cluster: ${describeFailure(error)}; escalating`);
      await stopCluster(dataDir, "immediate").catch((escalated: unknown) => {
        onTeardownFailure(`throwaway cluster did not stop: ${describeFailure(escalated)}`);
      });
    }
  }
  await rm(directory, { recursive: true, force: true }).catch((error: unknown) => {
    onTeardownFailure(
      `throwaway cluster directory ${directory} was not deleted and holds a ` +
        `restored copy of the records: ${describeFailure(error)}`,
    );
  });
}

async function stopCluster(dataDir: string, mode: "fast" | "immediate"): Promise<void> {
  await runTool("pg_ctl", ["stop", "-D", dataDir, "-m", mode, "-w", "-t", String(PG_CTL_WAIT_SECONDS)], {
    timeoutMs: PG_CTL_TIMEOUT_MS,
    stderr: "forward",
  });
}

/**
 * The one thing a `finally` block cannot cover: being told to stop.
 *
 * `pg_ctl` starts the server in its own session, so a Ctrl-C at the terminal or
 * launchd's SIGTERM ends this process and leaves a postmaster running from a
 * temp directory holding a restored copy of every receipt. Synchronous because
 * nothing asynchronous is safe to rely on in a signal handler that is about to
 * exit.
 */
function armEmergencyTeardown(directory: string, dataDir: string): () => void {
  const onSignal = (signal: NodeJS.Signals) => {
    spawnSync("pg_ctl", ["stop", "-D", dataDir, "-m", "immediate", "-w"], { stdio: "ignore" });
    rmSync(directory, { recursive: true, force: true });
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  };
}

/** Built through URL so a generated password can never need hand-escaping. */
function clusterUrl(port: number, password: string): string {
  const url = new URL(`postgres://127.0.0.1:${port}/${RESTORE_DATABASE}?sslmode=disable`);
  url.username = CLUSTER_USER;
  url.password = password;
  return url.toString();
}
