import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api.js";
import {
  MAX_POLL_FAILURES,
  isLiveExport,
  liveExportJob,
  pollGivesUp,
  startDownload,
} from "../src/exportJobs.js";
import type { ExportJob, ExportStatus } from "../src/types.js";

function job(id: string, status: ExportStatus): ExportJob {
  return {
    id,
    status,
    periodStart: "2026-01-01",
    periodEnd: "2026-12-31",
    error: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    completedAt: null,
    downloadUrl: null,
  };
}

describe("isLiveExport - what is worth polling", () => {
  it("is true for queued and running only", () => {
    expect(isLiveExport("queued")).toBe(true);
    expect(isLiveExport("running")).toBe(true);
  });

  it("is false for every terminal status - failed, stale and expired stay terminal", () => {
    for (const status of ["complete", "failed", "stale", "expired"] as const) {
      expect(isLiveExport(status)).toBe(false);
    }
  });
});

describe("liveExportJob - the job to resume watching", () => {
  it("finds a running job among finished ones, wherever it sits", () => {
    const jobs = [job("a", "complete"), job("b", "running"), job("c", "failed")];
    expect(liveExportJob(jobs)?.id).toBe("b");
  });

  it("finds a queued job too - the 409 case the moment after someone else's click", () => {
    expect(liveExportJob([job("a", "queued")])?.id).toBe("a");
  });

  it("finds nothing when everything is terminal", () => {
    const jobs = [job("a", "failed"), job("b", "stale"), job("c", "expired")];
    expect(liveExportJob(jobs)).toBeUndefined();
  });

  it("finds nothing in an empty list - a failed refresh reads as no job to resume", () => {
    expect(liveExportJob([])).toBeUndefined();
  });
});

describe("pollGivesUp - which failures end the watch", () => {
  it("waits out a network failure, which used to end it on the first one", () => {
    expect(pollGivesUp(new TypeError("Failed to fetch"), 1)).toBe(false);
  });

  it("waits out a server error and an unreadable body", () => {
    expect(pollGivesUp(new ApiError(502, "unreadable_response", "bad"), 3)).toBe(false);
    expect(pollGivesUp(new ApiError(500, "internal", "boom"), 3)).toBe(false);
  });

  it("waits out being asked to slow down", () => {
    expect(pollGivesUp(new ApiError(429, "rate_limited", "slow"), 3)).toBe(false);
    expect(pollGivesUp(new ApiError(408, "timeout", "slow"), 3)).toBe(false);
  });

  it("stops on a 4xx - asking again cannot change that answer", () => {
    expect(pollGivesUp(new ApiError(404, "not_found", "gone"), 1)).toBe(true);
    expect(pollGivesUp(new ApiError(401, "unauthorized", "expired"), 1)).toBe(true);
  });

  it("stops at the limit however transient the failure looks", () => {
    const transient = new TypeError("Failed to fetch");
    expect(pollGivesUp(transient, MAX_POLL_FAILURES - 1)).toBe(false);
    expect(pollGivesUp(transient, MAX_POLL_FAILURES)).toBe(true);
  });
});

describe("startDownload - a fresh URL, without leaving the app", () => {
  /** The little of `Document` this touches, recording what it was asked. */
  function fakeDocument() {
    const appended: Partial<HTMLIFrameElement>[] = [];
    const doc = {
      getElementById: (id: string) =>
        appended.find((frame) => frame.id === id) ?? null,
      createElement: () => ({}),
      body: {
        appendChild: (frame: Partial<HTMLIFrameElement>) => appended.push(frame),
      },
    };
    return { doc: doc as unknown as Document, appended };
  }

  it("loads the URL in a hidden frame", () => {
    const { doc, appended } = fakeDocument();
    startDownload("https://r2.example/export.zip?sig=1", doc);
    expect(appended).toHaveLength(1);
    expect(appended[0]?.src).toBe("https://r2.example/export.zip?sig=1");
    expect(appended[0]?.hidden).toBe(true);
  });

  it("reuses the frame rather than leaving one per click", () => {
    const { doc, appended } = fakeDocument();
    startDownload("https://r2.example/a.zip", doc);
    startDownload("https://r2.example/b.zip", doc);
    expect(appended).toHaveLength(1);
    expect(appended[0]?.src).toBe("https://r2.example/b.zip");
  });
});
