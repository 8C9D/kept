import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeptApi } from "../api.js";
import { ApiError, type ExportRequest } from "../api.js";
import { logEvent } from "../events.js";
import {
  isLiveExport,
  liveExportJob,
  pollGivesUp,
  startDownload,
} from "../exportJobs.js";
import {
  fiscalQuarters,
  fiscalYearToDate,
  lastFiscalYear,
  todayCalendarDate,
  type CalendarDate,
  type DateRange,
  type FiscalYearEnd,
} from "../fiscalPresets.js";
import { LatestRequest } from "../requests.js";
import type { ExportJob, Profile } from "../types.js";
import { useGuardedAction } from "../useGuardedAction.js";

/**
 * Spec §7A screen 4: pick a period, generate, download the zip. The job is
 * a row the server owns; this screen starts one, polls it, and lists the
 * history. The statuses that mean "re-run" instead of "wait" - expired,
 * stale - come computed from the server and are rendered as themselves.
 *
 * Since the job is the server's, this screen's knowledge of it must not be
 * what keeps it alive (2026-10). Which job to watch is re-derived from the
 * list on every arrival and after every 409, so leaving mid-generation and
 * coming back, or being told an export is already running, resumes the
 * watching instead of leaving a live job that nothing is looking at.
 */
const POLL_INTERVAL_MS = 2_000;
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Proposal #10 (approved, docs/proposals/2026-08-28-ux-enhancements.md #10):
 * "Last fiscal year", "This fiscal year to date", and the four quarters of
 * the current fiscal year, alongside the pre-existing "fiscal year ending
 * in <N>" and explicit-range controls. Every date shown or sent here comes
 * from `fiscalPresets.ts`, driven by THIS user's own
 * `fiscalYearEndMonth`/`fiscalYearEndDay` (`profile`, loaded below) - never
 * the calendar year - which is the one thing the proposal names as the
 * risk to get right.
 */
type PeriodPreset = "lastFiscalYear" | "yearToDate" | "q1" | "q2" | "q3" | "q4";

const PRESET_LABELS: Record<PeriodPreset, string> = {
  lastFiscalYear: "Last fiscal year",
  yearToDate: "This fiscal year to date",
  q1: "Q1",
  q2: "Q2",
  q3: "Q3",
  q4: "Q4",
};

/**
 * A preset resolved against one user's fiscal year end: what to show
 * (`range`) and exactly what `start()` below sends (`request`).
 *
 * "Last fiscal year" prefers `{fiscalYearEndingIn}` and lets the SERVER
 * derive the actual dates (§4.1a, §5.1) - `range` here is a preview only,
 * computed the same way purely so it can be shown before generating
 * anything (proposal #10's own requirement); it is not what gets sent.
 * The other three presets have no `{fiscalYearEndingIn}` equivalent (the
 * API only derives a whole fiscal year that way, never a quarter or a
 * to-date slice), so `range` IS the request for those - computed once,
 * sent unchanged.
 */
function resolvePreset(
  preset: PeriodPreset,
  today: CalendarDate,
  fye: FiscalYearEnd,
): { range: DateRange; request: ExportRequest } {
  switch (preset) {
    case "lastFiscalYear": {
      const { endYear, range } = lastFiscalYear(today, fye);
      return { range, request: { fiscalYearEndingIn: endYear } };
    }
    case "yearToDate": {
      const range = fiscalYearToDate(today, fye);
      return { range, request: { periodStart: range.start, periodEnd: range.end } };
    }
    case "q1":
    case "q2":
    case "q3":
    case "q4": {
      const [q1, q2, q3, q4] = fiscalQuarters(today, fye);
      const range = { q1, q2, q3, q4 }[preset];
      return { range, request: { periodStart: range.start, periodEnd: range.end } };
    }
  }
}

export function ExportView({ api }: { api: KeptApi }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  // Separate from `error` below because it has its own remedy. A failed
  // profile fetch used to be indistinguishable from one still loading: the
  // presets just never appeared, with nothing to say why.
  const [profileError, setProfileError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<ExportJob[]>([]);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fiscalYear, setFiscalYear] = useState(new Date().getFullYear());
  const [rangeStart, setRangeStart] = useState("");
  const [rangeEnd, setRangeEnd] = useState("");
  const [preset, setPreset] = useState<PeriodPreset>("lastFiscalYear");
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // One generation per poll loop, so starting a loop retires any other and a
  // poll already in flight cannot reschedule itself past a loop's end.
  const polls = useRef(new LatestRequest());
  // Whether this screen is showing. Read by anything that would start a loop
  // once an await resolves: a timer set after the unmount cleanup has run
  // has nothing left to clear it, and polls for the life of the tab.
  const onScreen = useRef(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const { busy: downloading, run: runDownload } = useGuardedAction();

  // Computed once per mount, not re-read on every render: the export
  // screen is opened, used for a moment, and left - there is no realistic
  // session that spans a midnight rollover, so a stable "today" costs
  // nothing and keeps the preset dropdown from silently reflowing under
  // someone mid-choice.
  const today = useMemo(() => todayCalendarDate(new Date()), []);
  const resolvedPreset =
    profile === null
      ? null
      : resolvePreset(preset, today, {
          month: profile.fiscalYearEndMonth,
          day: profile.fiscalYearEndDay,
        });

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

  const loadProfile = useCallback(async () => {
    setProfileError(null);
    try {
      setProfile(await api.me());
    } catch (caught) {
      setProfile(null);
      setProfileError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [api]);

  const stopPolling = useCallback(() => {
    polls.current.begin();
    if (pollTimer.current !== null) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  /**
   * Watches one job until it stops being live. A failed poll is waited out
   * rather than ending the watch (`pollGivesUp` has the rule), and the count
   * restarts on any good answer, so a flaky connection never adds up to
   * giving up.
   */
  const startPolling = useCallback(
    (jobId: string) => {
      if (!onScreen.current) {
        return;
      }
      stopPolling();
      const ticket = polls.current.begin();
      setActiveJobId(jobId);
      let failures = 0;
      const schedule = () => {
        pollTimer.current = setTimeout(() => void poll(), POLL_INTERVAL_MS);
      };
      const poll = async () => {
        let job: ExportJob;
        try {
          job = await api.pollExportJob(jobId);
        } catch (caught) {
          if (!polls.current.isLatest(ticket)) {
            return;
          }
          failures += 1;
          if (pollGivesUp(caught, failures)) {
            setActiveJobId(null);
            setError(caught instanceof Error ? caught.message : String(caught));
          } else {
            schedule();
          }
          return;
        }
        if (!polls.current.isLatest(ticket)) {
          return;
        }
        failures = 0;
        setJobs((current) => current.map((j) => (j.id === jobId ? job : j)));
        if (isLiveExport(job.status)) {
          schedule();
          return;
        }
        setActiveJobId(null);
        // A job can fail after it was accepted (generation itself errors
        // out), distinct from `start` below's request-time failure - both
        // are export_failed, the vocabulary has no separate name for
        // "failed later."
        if (job.status === "failed") {
          logEvent({ action: "export_failed" });
        }
        await refreshJobs();
      };
      schedule();
    },
    [api, refreshJobs, stopPolling],
  );

  const resumePolling = useCallback(
    (loaded: readonly ExportJob[]) => {
      const live = liveExportJob(loaded);
      if (live !== undefined) {
        startPolling(live.id);
      }
    },
    [startPolling],
  );

  useEffect(() => {
    onScreen.current = true;
    void loadProfile();
    void refreshJobs().then(resumePolling);
    return () => {
      onScreen.current = false;
      stopPolling();
    };
  }, [loadProfile, refreshJobs, resumePolling, stopPolling]);

  async function start(request: ExportRequest) {
    setError(null);
    logEvent({ action: "export_requested" });
    try {
      const job = await api.startExport(request);
      setJobs((current) => [job, ...current]);
      startPolling(job.id);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "export_already_running") {
        setError(caught.message);
        resumePolling(await refreshJobs());
        return;
      }
      logEvent({ action: "export_failed" });
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  /**
   * Download asks the server for a URL at the moment of the click, because a
   * presigned URL lives five minutes (`PRESIGN_EXPIRY_SECONDS`) and the zip
   * behind it lives thirty days. The URL the job list carried was dead long
   * before the screen said it would be: clicking it replaced this tab with
   * R2's error XML, and logged a download that never happened. So the event
   * here fires only with a live URL in hand, and every way of not getting
   * one is said on this screen.
   */
  async function download(job: ExportJob) {
    setError(null);
    setDownloadingId(job.id);
    try {
      const fresh = await api.exportJob(job.id);
      setJobs((current) => current.map((j) => (j.id === job.id ? fresh : j)));
      if (fresh.downloadUrl === null) {
        setError(
          "This export can no longer be downloaded - re-run the period for a fresh zip.",
        );
        return;
      }
      startDownload(fresh.downloadUrl);
      logEvent({ action: "export_downloaded" });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setDownloadingId(null);
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
        every image, named for the period. A finished export can be
        downloaded for 30 days; after that, re-run the period - the receipts
        are the records, the zip is regenerable.
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
        {/* Proposal #10: presets over the two controls above, all driven by
            THIS user's own fiscal year end (profile, loaded on mount) - a
            person who has not configured one still gets the correct
            calendar-year default (§5.1: "default to 31 December"), not a
            silently different one from the two starters beside it. Hidden
            entirely until the profile loads rather than rendered with a
            guessed year end, since a wrong preset here would look exactly
            as plausible as a right one - and when the load fails, the note
            below says so, rather than the presets simply not being there. */}
        {profileError !== null && (
          <p className="error">
            The fiscal period presets could not be loaded: {profileError}{" "}
            <button className="link" onClick={() => void loadProfile()}>
              Try again
            </button>
          </p>
        )}
        {profile !== null && resolvedPreset !== null && (
          <div className="starter">
            <label>
              Period
              <select
                value={preset}
                onChange={(e) => setPreset(e.target.value as PeriodPreset)}
              >
                {(Object.keys(PRESET_LABELS) as PeriodPreset[]).map((key) => (
                  <option key={key} value={key}>
                    {PRESET_LABELS[key]}
                  </option>
                ))}
              </select>
            </label>
            {/* The resolved range, shown before generating anything
                (proposal #10's own requirement) - an export names its own
                period in its filename (§8), and someone should be able to
                see what they are about to ask for. */}
            <span className="muted">
              {resolvedPreset.range.start} → {resolvedPreset.range.end}
            </span>
            <button
              className="primary"
              disabled={activeJobId !== null}
              onClick={() => void start(resolvedPreset.request)}
            >
              Export period
            </button>
          </div>
        )}
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
                {/* The URL here only says the job has a zip; it is never
                    followed, for the reason on `download` above. */}
                {job.downloadUrl !== null && (
                  <button
                    className="download-link"
                    disabled={downloading}
                    onClick={() => runDownload(() => download(job))}
                  >
                    {downloadingId === job.id ? "Preparing…" : "Download zip"}
                  </button>
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
