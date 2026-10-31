import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

/**
 * A `wrangler` executable that behaves the way the installed 4.124.0 CLI was
 * measured to behave, for the adapter and for a real job run in wrangler mode.
 * It records every invocation, serves objects from a directory, and can be told
 * to fail in the two ways that matter:
 *
 *   - absent:    exit 1, the real message on stderr in the real ANSI colour,
 *                and a 0-byte file left at --file (the CLI creates it before it
 *                makes the request);
 *   - transient: exit 1 with some other error, the same 0-byte file;
 *   - empty:     exit 0 with a 0-byte file, the case an exit code cannot catch.
 *
 * Failures are read from `plan`, one line consumed per `get`, so a test can say
 * "fail twice, then work". An empty plan means normal behaviour.
 *
 * `delete` exits 0 whether or not the key is there, as `deleteR2Object` in the
 * same version reads, and `planDeletes` is its own plan: `transient` fails, and
 * `noop` exits 0 and removes nothing, which is what a missing bucket would do.
 */
const SCRIPT = String.raw`#!/bin/sh
state="$FAKE_WRANGLER_STATE"
printf '%s\n' "$*" >> "$state/argv.log"
printf 'cwd=%s metrics=%s\n' "$(pwd)" "$WRANGLER_SEND_METRICS" >> "$state/env.log"

if [ "$1" = "--version" ]; then
  echo 4.124.0
  exit 0
fi

verb="$3"
object="$4"
shift 4
file=""
content_type=""
while [ $# -gt 0 ]; do
  case "$1" in
    --file) file="$2"; shift 2 ;;
    --content-type) content_type="$2"; shift 2 ;;
    *) shift ;;
  esac
done
stored="$state/objects/$object"

case "$verb" in
  get)
    # Created before the request, exactly as the real CLI does.
    : > "$file"
    printf '%s\n' "$file" >> "$state/temp-files.log"
    step=""
    if [ -s "$state/plan" ]; then
      step="$(head -n 1 "$state/plan")"
      tail -n +2 "$state/plan" > "$state/plan.next"
      mv "$state/plan.next" "$state/plan"
    fi
    case "$step" in
      transient)
        printf '\033[31m✘ \033[41;31m[\033[41;97mERROR\033[41;31m]\033[0m \033[1mFailed to fetch /r2/objects - 500: Internal Server Error;\033[0m\n' >&2
        exit 1
        ;;
      empty)
        exit 0
        ;;
    esac
    if [ ! -f "$stored" ]; then
      printf '\033[31m✘ \033[41;31m[\033[41;97mERROR\033[41;31m]\033[0m \033[1mThe specified key does not exist.\033[0m\n' >&2
      exit 1
    fi
    cp "$stored" "$file"
    ;;
  put)
    mkdir -p "$(dirname "$stored")"
    cp "$file" "$stored"
    printf '%s\n' "$content_type" > "$stored.content-type"
    ;;
  delete)
    step=""
    if [ -s "$state/delete-plan" ]; then
      step="$(head -n 1 "$state/delete-plan")"
      tail -n +2 "$state/delete-plan" > "$state/delete-plan.next"
      mv "$state/delete-plan.next" "$state/delete-plan"
    fi
    case "$step" in
      transient)
        printf '\033[31m✘ \033[41;31m[\033[41;97mERROR\033[41;31m]\033[0m \033[1mFailed to fetch /r2/objects - 500: Internal Server Error;\033[0m\n' >&2
        exit 1
        ;;
      noop)
        echo "Delete complete."
        exit 0
        ;;
    esac
    rm -f "$stored" "$stored.content-type"
    echo "Delete complete."
    ;;
  *)
    echo "fake wrangler: unexpected verb $verb" >&2
    exit 64
    ;;
esac
`;

export interface FakeWrangler {
  /** Directory to put first on PATH. */
  binDir: string;
  env(base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  store(bucket: string, key: string, bytes: Uint8Array): void;
  stored(bucket: string, key: string): Uint8Array;
  storedContentType(bucket: string, key: string): string;
  plan(steps: Array<"transient" | "empty" | "normal">): void;
  planDeletes(steps: Array<"transient" | "noop" | "normal">): void;
  argv(): string[];
  envLog(): string[];
  tempFiles(): string[];
  close(): void;
}

export function createFakeWrangler(): FakeWrangler {
  const root = mkdtempSync(join(tmpdir(), "kept-fake-wrangler-"));
  const binDir = join(root, "bin");
  const state = join(root, "state");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(join(state, "objects"), { recursive: true });
  writeFileSync(join(binDir, "wrangler"), SCRIPT);
  chmodSync(join(binDir, "wrangler"), 0o755);
  writeFileSync(join(state, "argv.log"), "");
  writeFileSync(join(state, "env.log"), "");
  writeFileSync(join(state, "temp-files.log"), "");

  const lines = (name: string) =>
    readFileSync(join(state, name), "utf8")
      .split("\n")
      .filter((line) => line !== "");

  return {
    binDir,
    env: (base = process.env) => ({
      ...base,
      PATH: `${binDir}:${base.PATH}`,
      FAKE_WRANGLER_STATE: state,
    }),
    store(bucket, key, bytes) {
      const path = join(state, "objects", bucket, key);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
    },
    stored: (bucket, key) => new Uint8Array(readFileSync(join(state, "objects", bucket, key))),
    storedContentType: (bucket, key) =>
      readFileSync(join(state, "objects", bucket, `${key}.content-type`), "utf8").trim(),
    plan(steps) {
      writeFileSync(join(state, "plan"), steps.map((step) => `${step}\n`).join(""));
    },
    planDeletes(steps) {
      writeFileSync(join(state, "delete-plan"), steps.map((step) => `${step}\n`).join(""));
    },
    argv: () => lines("argv.log"),
    envLog: () => lines("env.log"),
    tempFiles: () => lines("temp-files.log"),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}
