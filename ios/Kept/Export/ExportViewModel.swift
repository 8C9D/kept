import Foundation

/// The export screen's state and decisions (2026-08-28 - see
/// ExportView.swift for why this screen exists). It owns two things the
/// server hands it and nothing else: a job to poll, and a finished zip to
/// stream to disk. It derives no dates, computes no fiscal period, and
/// never holds the zip's bytes in memory - all of that stays the server's
/// (spec §4.1, §8), which is the whole point of the trade this screen
/// exists to keep.
@MainActor
final class ExportViewModel: ObservableObject {
    /// Where a just-submitted request stands. Separate from `activeJob`
    /// (which is about a job that exists) because a 409 or a validation
    /// failure means no job was created at all - there is nothing yet to
    /// track.
    enum StartOutcome: Equatable {
        case idle
        case starting
        /// The 409 `export_already_running` (spec §8): refused, not
        /// queued - a peak export runs close to the origin's memory
        /// budget, so the server declines a second one outright rather
        /// than queuing it. Carries the server's own explanation, shown
        /// verbatim rather than replaced with this screen's wording.
        case alreadyRunning(String)
        /// Any other rejection - a network failure, a validation error.
        case failed(String)

        /// The reason, when this is a plain failure - the shape a SwiftUI
        /// alert binding needs, same pattern as
        /// SessionController.AccountDeletion.failureMessage.
        var failureMessage: String? {
            if case .failed(let message) = self { return message }
            return nil
        }

        /// The reason, when this is the refused-not-queued outcome.
        /// Deliberately separate from `failureMessage`: the view shows
        /// this one inline near the starters rather than as an alert,
        /// because the useful next step is looking at History, not
        /// dismissing a dialog.
        var alreadyRunningMessage: String? {
            if case .alreadyRunning(let message) = self { return message }
            return nil
        }
    }

    /// A download streamed to a temporary file. `downloading` and `ready`
    /// both carry nothing else because the file's path lives in `ready`
    /// only - the one moment code outside this model needs it, to hand to
    /// a share sheet.
    enum DownloadState: Equatable {
        case idle
        case downloading
        case failed(String)
        case ready(URL)
    }

    @Published private(set) var startOutcome: StartOutcome = .idle
    /// The job this screen is currently watching - just started, or
    /// picked back up from history. Only one at a time, matching the
    /// server's one-live-export-per-user rule: starting or watching a new
    /// one replaces whatever was here, and cancels its poll.
    @Published private(set) var activeJob: ExportJob?
    @Published private(set) var history: [ExportJob] = []
    @Published private(set) var historyError: String?
    @Published private(set) var download: DownloadState = .idle

    private let api: any KeptAPI
    private let eventLogger: EventLogger
    private let pollInterval: Duration
    /// Downloads the zip at a URL to a local temporary file, returning
    /// where it landed and the response. Production hands this straight
    /// to `URLSession`'s download task, which streams bytes to disk as
    /// they arrive; tests substitute a closure that never touches the
    /// network, so the download path is exercised without one.
    private let downloader: (URL) async throws -> (URL, URLResponse)

    private var pollTask: Task<Void, Never>?
    private var downloadTask: Task<Void, Never>?

    init(
        api: any KeptAPI,
        eventLogger: EventLogger,
        pollInterval: Duration = .seconds(2),
        downloader: @escaping (URL) async throws -> (URL, URLResponse) = { url in
            try await URLSession.shared.download(from: url)
        }
    ) {
        self.api = api
        self.eventLogger = eventLogger
        self.pollInterval = pollInterval
        self.downloader = downloader
    }

    deinit {
        pollTask?.cancel()
        downloadTask?.cancel()
    }

    // MARK: - History

    /// The caller's own jobs, newest first - what lets an `expired` or
    /// `stale` job (or simply an older `complete` one) be picked back up
    /// without starting over.
    func loadHistory() async {
        do {
            history = try await api.exportJobs()
            historyError = nil
        } catch {
            historyError = error.localizedDescription
        }
    }

    // MARK: - Starting

    func start(_ request: ExportRequest) async {
        guard startOutcome != .starting else { return }
        startOutcome = .starting
        do {
            let job = try await api.startExport(request)
            startOutcome = .idle
            beginTracking(job)
            eventLogger.log(.exportRequested)
        } catch let APIError.requestFailed(code, message, _) where code == "export_already_running" {
            // Refused outcome, explained by the server - not a generic
            // failure. The already-running job is presumably in the
            // history the refresh below fetches, so the person can jump
            // to watching it instead of being left with just an error.
            // Not `export_failed`: nothing failed here, a second export
            // was refused because one is already live (spec §8).
            startOutcome = .alreadyRunning(message)
            await loadHistory()
        } catch {
            startOutcome = .failed(error.localizedDescription)
            eventLogger.log(.exportFailed)
        }
    }

    func clearStartFailure() {
        switch startOutcome {
        case .failed, .alreadyRunning:
            startOutcome = .idle
        case .idle, .starting:
            break
        }
    }

    // MARK: - Tracking / polling

    /// Watches a job from history again - re-checking an `expired` or
    /// `stale` one is pointless (their status will not change), but
    /// re-attaching to a still-`queued`/`running` one left behind by
    /// leaving the screen, or simply looking at a `complete` one to
    /// download it, both go through here.
    func watch(_ job: ExportJob) {
        beginTracking(job)
    }

    /// Re-runs an `expired` or `stale` job's exact period (spec §8: the
    /// period is always present so a re-run needs nothing else) - offered
    /// beside those two statuses so "re-run the period" is a tap, not a
    /// trip back to the starter fields to reconstruct what was already
    /// chosen once.
    func rerun(_ job: ExportJob) async {
        await start(.range(periodStart: job.periodStart, periodEnd: job.periodEnd))
    }

    private func beginTracking(_ job: ExportJob) {
        pollTask?.cancel()
        cancelDownload()
        activeJob = job
        guard !job.status.isTerminal else { return }
        let id = job.id
        pollTask = Task { [weak self] in
            await self?.pollLoop(id: id)
        }
    }

    private func pollLoop(id: UUID) async {
        while true {
            do {
                try await Task.sleep(for: pollInterval)
            } catch {
                return // Cancelled - a new track() or the view going away.
            }
            guard activeJob?.id == id else { return }
            await refresh(id: id)
            guard activeJob?.id == id, activeJob?.status.isTerminal == false else { return }
        }
    }

    /// One poll step against the server, kept separate from the sleeping
    /// loop above so a test can assert its effect directly rather than
    /// waiting out `pollInterval`. A no-op if a different job has since
    /// become the tracked one - every job the server creates gets its own
    /// row and so its own id, which makes `id` itself a sufficient guard
    /// against a response arriving after it was superseded.
    func refresh(id: UUID) async {
        guard activeJob?.id == id else { return }
        do {
            let job = try await api.exportJob(id: id)
            guard activeJob?.id == id else { return }
            let wasAlreadyFailed = activeJob?.status == .failed
            activeJob = job
            if job.status.isTerminal {
                // The just-finished (or just-discovered-lost) job belongs
                // in the history list's status too, not only in
                // `activeJob`.
                await loadHistory()
            }
            // `export_failed`, the other way a job can fail beyond
            // start() itself throwing: discovered on a poll rather than
            // at request time. Guarded against the status already having
            // been `.failed` on the previous poll, so re-watching a
            // failed job from history (watch(_:)) does not log it again
            // on every subsequent tick.
            if job.status == .failed && !wasAlreadyFailed {
                eventLogger.log(.exportFailed)
            }
        } catch {
            // A single poll failing is a network hiccup, not the job
            // failing - the next tick tries again rather than reporting a
            // failure the server never actually recorded.
        }
    }

    /// Stops polling and discards the tracked job, without starting or
    /// resuming anything - the view's "never mind" path off the active
    /// job, back to just the starters and history.
    func stopTracking() {
        pollTask?.cancel()
        pollTask = nil
        cancelDownload()
        activeJob = nil
    }

    // MARK: - Downloading

    /// Streams the active job's zip to a local temporary file via a
    /// `URLSession` download task rather than `Data(contentsOf:)` - the
    /// requirement this whole screen exists to satisfy without giving up
    /// the concern §4.1a raised: an export at the byte budget peaks near
    /// 890 MB, and a download task writes those bytes to disk as they
    /// arrive instead of holding them in memory at once.
    func downloadZip() {
        guard let job = activeJob, let url = job.downloadUrl, download != .downloading else { return }
        download = .downloading
        downloadTask = Task { [weak self] in
            await self?.performDownload(from: url)
        }
    }

    /// Cancels an in-flight download. `URLSession`'s async download API
    /// observes Swift task cancellation itself and cancels the underlying
    /// `URLSessionTask` with it, so cancelling this wrapper task is
    /// sufficient - no separate handle to the network task is needed.
    func cancelDownload() {
        downloadTask?.cancel()
        downloadTask = nil
        if download == .downloading {
            download = .idle
        }
    }

    /// Discards the downloaded temp file - called once the share sheet
    /// has done whatever it is going to do with it (saved to Files,
    /// AirDropped, mailed - all of which copy the bytes onward), so a
    /// multi-hundred-megabyte file does not linger in this app's temp
    /// directory after the person is done with it.
    func discardDownloadedFile() {
        if case .ready(let url) = download {
            try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
        }
        download = .idle
    }

    private func performDownload(from url: URL) async {
        do {
            let (tempURL, response) = try await downloader(url)
            if Task.isCancelled {
                try? FileManager.default.removeItem(at: tempURL)
                download = .idle
                return
            }
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                try? FileManager.default.removeItem(at: tempURL)
                download = .failed("The download failed (the server answered unexpectedly).")
                eventLogger.log(.exportFailed)
                return
            }
            // `URLSession` deletes its own temp file the moment this
            // method returns, so it is moved into a directory this app
            // owns before the caller ever sees the URL - and given a
            // subdirectory of its own so the server's suggested filename
            // (Content-Disposition on the presigned URL) can be kept
            // as-is for the share sheet without colliding with another
            // download.
            let directory = FileManager.default.temporaryDirectory
                .appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let filename = response.suggestedFilename ?? "Receipts.zip"
            let destination = directory.appendingPathComponent(filename)
            try FileManager.default.moveItem(at: tempURL, to: destination)
            download = .ready(destination)
            eventLogger.log(.exportDownloaded)
        } catch is CancellationError {
            download = .idle
        } catch let urlError as URLError where urlError.code == .cancelled {
            download = .idle
        } catch {
            download = .failed(error.localizedDescription)
            eventLogger.log(.exportFailed)
        }
    }
}
