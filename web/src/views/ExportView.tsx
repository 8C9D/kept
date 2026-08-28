import { useCallback, useEffect, useRef, useState } from "react";
import type { KeptApi } from "../api.js";
import { ApiError, type ExportRequest } from "../api.js";
import { logEvent } from "../events.js";
import type { ExportJob, Profile } from "../types.js";

/**
 * Spec §7A screen 4: pick a period, generate, download the zip. The job is
 * a row the server owns; this screen starts one, polls it, and lists the
 * history. The statuses that mean "re-run" instead of "wait" - expired,
 * stale - come computed from the server and are rendered as themselves.
 */
const POLL_INTERVAL_MS = 2_000;
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function ExportView({ api }: { api: KeptApi }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [jobs, setJobs] = useState<ExportJob[]>([]);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fiscalYear, setFiscalYear] = useState(new Date().getFullYear());
  const [rangeStart, setRangeStart] = useState("");
  const [rangeEnd, setRangeEnd] = useState("");
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshJobs = useCallback(async () => {
    try {
      const { jobs: loaded } = await api.exportJobs();
      setJobs(loaded);
      return loaded;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return [];
    }
  }, [api]);

  useEffect(() => {
    void api.me().then(setProfile, () => setProfile(null));
    void refreshJobs();
    return () => {
      if (pollTimer.current !== null) {
        clearTimeout(pollTimer.current);
      }
    };
  }, [api, refreshJobs]);

  const poll = useCallback(
    async (jobId: string) => {
      try {
        const job = await api.exportJob(jobId);
        setJobs((current) =>
          current.map((j) => (j.id === jobId ? job : j)),
        );
        if (job.status === "queued" || job.status === "running") {
          pollTimer.current = setTimeout(() => void poll(jobId), POLL_INTERVAL_MS);
        } else {
          setActiveJobId(null);
          // A job can fail after it was accepted (generation itself errors
          // out), distinct from `start` below's request-time failure - both
          // are export_failed, the vocabulary has no separate name for
          // "failed later."
          if (job.status === "failed") {
            logEvent({ action: "export_failed" });
          }
          await refreshJobs();
        }
      } catch (caught) {
        setActiveJobId(null);
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [api, refreshJobs],
  );

  async function start(request: ExportRequest) {
    setError(null);
    logEvent({ action: "export_requested" });
    try {
      const job = await api.startExport(request);
      setJobs((current) => [job, ...current]);
      setActiveJobId(job.id);
      pollTimer.current = setTimeout(() => void poll(job.id), POLL_INTERVAL_MS);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "export_already_running") {
        setError(caught.message);
        await refreshJobs();
        return;
      }
      logEvent({ action: "export_failed" });
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  const fiscalYearEnd =
    profile === null
      ? null
      : `${MONTH_NAMES[profile.fiscalYearEndMonth - 1]} ${profile.fiscalYearEndDay}`;

  return (
    <section className="export-view">
      <h2>Year-end export</h2>
      <p className="muted">
        A zip with the same rows in three formats - XLSX, CSV and JSON - and
        every image, named for the period. Links stay good for 30 days;
        after that, re-run the period - the receipts are the records, the
        zip is regenerable.
      </p>

      <div className="export-starters">
        <div className="starter">
          <label>
            Fiscal year ending in
            <input
              type="number"
              min={2000}
              max={2100}
              value={fiscalYear}
              onChange={(e) => setFiscalYear(Number(e.target.value))}
            />
          </label>
          {fiscalYearEnd !== null && (
            <span className="muted">year end: {fiscalYearEnd}</span>
          )}
          <button
            className="primary"
            disabled={activeJobId !== null}
            onClick={() => void start({ fiscalYearEndingIn: fiscalYear })}
          >
            Export fiscal year
          </button>
        </div>
        <div className="starter">
          <label>
            From
            <input
              type="date"
              value={rangeStart}
              onChange={(e) => setRangeStart(e.target.value)}
            />
          </label>
          <label>
            To
            <input
              type="date"
              value={rangeEnd}
              onChange={(e) => setRangeEnd(e.target.value)}
            />
          </label>
          <button
            className="primary"
            disabled={activeJobId !== null || rangeStart === "" || rangeEnd === ""}
            onClick={() =>
              void start({ periodStart: rangeStart, periodEnd: rangeEnd })
            }
          >
            Export range
          </button>
        </div>
      </div>

      {error !== null && <p className="error">{error}</p>}

      <table className="export-jobs">
        <thead>
          <tr>
            <th>Period</th>
            <th>Started</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {jobs.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                No exports yet.
              </td>
            </tr>
          )}
          {jobs.map((job) => (
            <tr key={job.id}>
              <td>
                {job.periodStart} → {job.periodEnd}
              </td>
              <td>{new Date(job.createdAt).toLocaleString()}</td>
              <td className={`export-status ${job.status}`}>
                {describeStatus(job)}
              </td>
              <td>
                {job.downloadUrl !== null && (
                  <a
                    className="download-link"
                    href={job.downloadUrl}
                    // The click itself, not a completed transfer - a plain
                    // navigating anchor gives this component no signal once
                    // the browser takes over the download, and no
                    // preventDefault here (rule 1: never block a user
                    // action on telemetry).
                    onClick={() => logEvent({ action: "export_downloaded" })}
                  >
                    Download zip
                  </a>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function describeStatus(job: ExportJob): string {
  switch (job.status) {
    case "queued":
      return "queued…";
    case "running":
      return "generating…";
    case "complete":
      return "complete";
    case "failed":
      return job.error === null ? "failed" : `failed: ${job.error}`;
    case "expired":
      return "expired - re-run the period for a fresh zip";
    case "stale":
      return "lost before finishing - re-run the period";
  }
}
