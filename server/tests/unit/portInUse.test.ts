import { describe, expect, it } from "vitest";
import {
  formatPortInUseMessage,
  parseLsofListeners,
  type PortListener,
} from "../../src/observability/portInUse.js";

/** Real `lsof -nP -iTCP:3000 -sTCP:LISTEN` output, two fds on one pid. */
const LSOF_OUTPUT = `COMMAND   PID        USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node    57684 <user>   23u  IPv6 0x1234567890abcdef      0t0  TCP *:3000 (LISTEN)
node    57684 <user>   24u  IPv4 0xabcdef1234567890      0t0  TCP *:3000 (LISTEN)
`;

const STALE_KEPT_SERVER: PortListener = {
  pid: 57684,
  command: "node",
  startedAt: "Thu Aug  6 20:47:11 2026",
  fullCommand: "node --env-file=.env.local --import tsx src/index.ts",
};

describe("parseLsofListeners", () => {
  it("reads the pid and command, skipping the header", () => {
    expect(parseLsofListeners(LSOF_OUTPUT)).toEqual([
      { pid: 57684, command: "node" },
      { pid: 57684, command: "node" },
    ]);
  });

  it("ignores lines it cannot read rather than guessing", () => {
    expect(parseLsofListeners("COMMAND PID\n\ngarbage\n")).toEqual([]);
  });

  it("returns nothing for empty output", () => {
    expect(parseLsofListeners("")).toEqual([]);
  });
});

describe("formatPortInUseMessage", () => {
  it("names the process, when it started, and what it is running", () => {
    const message = formatPortInUseMessage(3000, [STALE_KEPT_SERVER]);
    expect(message).toContain("Port 3000 is already in use");
    expect(message).toContain("pid 57684");
    expect(message).toContain("Thu Aug  6 20:47:11 2026");
    expect(message).toContain("src/index.ts");
    expect(message).toContain("kill 57684");
  });

  /**
   * The whole point. Four times across waves, a stale dev server was found
   * holding this port, and the risk is not the failed start - it is the
   * measurement someone takes against the older build without noticing.
   */
  it("says what a stale Kept server means for anything measured against it", () => {
    const message = formatPortInUseMessage(3000, [STALE_KEPT_SERVER]);
    expect(message).toContain("another Kept server");
    expect(message).toMatch(/serving the code it was started with/);
  });

  it("does not claim a stale Kept server when it is something else", () => {
    const message = formatPortInUseMessage(3000, [
      {
        pid: 900,
        command: "Google",
        startedAt: null,
        fullCommand: "/Applications/Google Chrome.app/Contents/MacOS/Chrome",
      },
    ]);
    expect(message).not.toContain("another Kept server");
    expect(message).toContain("pid 900");
    expect(message).toContain("kill 900");
  });

  it("still says what to do when the holder cannot be identified", () => {
    const message = formatPortInUseMessage(3000, []);
    expect(message).toContain("Could not identify");
    expect(message).toContain("lsof -nP -iTCP:3000 -sTCP:LISTEN");
    expect(message).toContain("PORT=3001");
  });

  it("lists every holder when more than one answers", () => {
    const message = formatPortInUseMessage(3000, [
      STALE_KEPT_SERVER,
      { ...STALE_KEPT_SERVER, pid: 99 },
    ]);
    expect(message).toContain("kill 57684 99");
  });
});
