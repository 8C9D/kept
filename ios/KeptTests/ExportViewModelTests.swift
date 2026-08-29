import XCTest
@testable import Kept

/// The export screen's state machine (spec §8): request → poll →
/// complete/failed/expired/stale, the 409-already-running path, and the
/// download-to-disk path - all without a screen, per ios/CLAUDE.md's
/// testability rule.
@MainActor
final class ExportViewModelTests: XCTestCase {
    private var api: StubKeptAPI!

    override func setUp() async throws {
        try await super.setUp()
        api = StubKeptAPI()
    }

    // MARK: - Profile (proposal #10, 2026-08-28 - drives the export presets)

    func testLoadProfileExposesTheFetchedFiscalYearEnd() async {
        let profile = Fixtures.profile(fiscalYearEndMonth: 6, fiscalYearEndDay: 30)
        api.fetchProfileHandler = { profile }
        let model = ExportViewModel(api: api, eventLogger: EventLogger(api: api), pollInterval: .seconds(999))

        await model.loadProfile()

        XCTAssertEqual(model.profile, profile)
    }

    /// The proposal's own risk, restated for this fetch: a failure here
    /// must never fabricate a year end (a guessed Dec 31 would be
    /// silently wrong for someone who set a different one) - `nil` is the
    /// only honest outcome, exactly like an unfetched profile.
    func testLoadProfileFailureLeavesProfileNilRatherThanGuessing() async {
        api.fetchProfileHandler = { throw APIError.network(URLError(.notConnectedToInternet)) }
        let model = ExportViewModel(api: api, eventLogger: EventLogger(api: api), pollInterval: .seconds(999))

        await model.loadProfile()

        XCTAssertNil(model.profile)
    }

    // MARK: - Starting

    func testStartSuccessBeginsTrackingTheReturnedJob() async {
        let job = Fixtures.exportJob(status: .queued)
        api.startExportHandler = { _ in job }
        let model = ExportViewModel(api: api, eventLogger: EventLogger(api: api), pollInterval: .seconds(999))

        await model.start(.fiscalYear(endingIn: 2026))

        XCTAssertEqual(model.startOutcome, .idle)
        XCTAssertEqual(model.activeJob, job)
        XCTAssertEqual(api.startExportCalls, [.fiscalYear(endingIn: 2026)])
    }

    func testStartEncodesAnExplicitRangeRequest() async {
        api.startExportHandler = { _ in Fixtures.exportJob() }
        let model = ExportViewModel(api: api, eventLogger: EventLogger(api: api), pollInterval: .seconds(999))

        await model.start(.range(periodStart: "2025-04-01", periodEnd: "2026-03-31"))

        XCTAssertEqual(api.startExportCalls, [.range(periodStart: "2025-04-01", periodEnd: "2026-03-31")])
    }

    /// The 409 the server answers when one export is already live: a
    /// specific, explained outcome (not a generic failure), and history
    /// refreshes alongside it so the running job is visible.
    func testStartAlreadyRunningIsASpecificOutcomeAndRefreshesHistory() async {
        api.startExportHandler = { _ in
            throw APIError.requestFailed(
                code: "export_already_running",
                message: "An export is already running. Wait for it to finish, then start the next one.",
                status: 409
            )
        }
        let existingJob = Fixtures.exportJob(status: .running)
        api.exportJobsHandler = { [existingJob] }
        let model = ExportViewModel(api: api, eventLogger: EventLogger(api: api), pollInterval: .seconds(999))

        await model.start(.fiscalYear(endingIn: 2026))

        XCTAssertEqual(
            model.startOutcome,
            .alreadyRunning("An export is already running. Wait for it to finish, then start the next one.")
        )
        XCTAssertNil(model.activeJob)
        XCTAssertEqual(model.history, [existingJob])
    }

    func testStartOtherFailureIsAPlainFailedOutcome() async {
        api.startExportHandler = { _ in
            throw APIError.network(URLError(.notConnectedToInternet))
        }
        let model = ExportViewModel(api: api, eventLogger: EventLogger(api: api), pollInterval: .seconds(999))

        await model.start(.fiscalYear(endingIn: 2026))

        XCTAssertNotNil(model.startOutcome.failureMessage)
        XCTAssertNil(model.startOutcome.alreadyRunningMessage)
    }

    func testClearStartFailureReturnsToIdle() async {
        api.startExportHandler = { _ in throw APIError.network(URLError(.timedOut)) }
        let model = ExportViewModel(api: api, eventLogger: EventLogger(api: api), pollInterval: .seconds(999))
        await model.start(.fiscalYear(endingIn: 2026))
        XCTAssertNotNil(model.startOutcome.failureMessage)

        model.clearStartFailure()

        XCTAssertEqual(model.startOutcome, .idle)
    }

    // MARK: - One poll step (refresh)

    func testRefreshUpdatesTheActiveJobFromTheServersLatestAnswer() async {
        let job = Fixtures.exportJob(status: .queued)
        api.startExportHandler = { _ in job }
        var handlerCallCount = 0
        api.exportJobHandler = { id in
            handlerCallCount += 1
            return Fixtures.exportJob(id: id, status: .running)
        }
        let model = ExportViewModel(api: api, eventLogger: EventLogger(api: api), pollInterval: .seconds(999))
        await model.start(.fiscalYear(endingIn: 2026))

        await model.refresh(id: job.id)

        XCTAssertEqual(handlerCallCount, 1)
        XCTAssertEqual(model.activeJob?.status, .running)
    }

    func testRefreshIgnoresAResponseForAJobThatIsNoLongerTracked() async {
        let staleId = UUID()
        api.exportJobHandler = { id in Fixtures.exportJob(id: id, status: .running) }
        let model = ExportViewModel(api: api, eventLogger: EventLogger(api: api), pollInterval: .seconds(999))
        // Nothing is tracked (activeJob is nil), so a poll response for
        // any id - including one that was never started - must be a
        // no-op rather than fabricating an active job from thin air.
        await model.refresh(id: staleId)

        XCTAssertNil(model.activeJob)
    }

    func testRefreshReachingATerminalStatusRefreshesHistory() async {
        let job = Fixtures.exportJob(status: .running)
        api.startExportHandler = { _ in job }
        let downloadUrl = URL(string: "https://example.com/receipts.zip")!
        api.exportJobHandler = { id in Fixtures.exportJob(id: id, status: .complete, downloadUrl: downloadUrl) }
        api.exportJobsHandler = { [Fixtures.exportJob(id: job.id, status: .complete, downloadUrl: downloadUrl)] }
        let model = ExportViewModel(api: api, eventLogger: EventLogger(api: api), pollInterval: .seconds(999))
        await model.start(.fiscalYear(endingIn: 2026))

        await model.refresh(id: job.id)

        XCTAssertEqual(model.activeJob?.status, .complete)
        XCTAssertEqual(model.history.first?.status, .complete)
    }

    // MARK: - The poll loop stops on a terminal status

    func testThePollLoopStopsCallingTheServerOnceAJobIsComplete() async {
        let job = Fixtures.exportJob(status: .queued)
        api.startExportHandler = { _ in job }
        var callCount = 0
        api.exportJobHandler = { id in
            callCount += 1
            // Reported complete on the very first poll - the loop must
            // not tick a second time after that.
            return Fixtures.exportJob(id: id, status: .complete)
        }
        // A tiny interval so the loop can tick several times inside a
        // short real-time wait without the test itself sleeping long.
        let model = ExportViewModel(api: api, eventLogger: EventLogger(api: api), pollInterval: .milliseconds(5))

        await model.start(.fiscalYear(endingIn: 2026))
        try? await Task.sleep(for: .milliseconds(80))

        XCTAssertEqual(model.activeJob?.status, .complete)
        XCTAssertEqual(callCount, 1)
    }

    func testThePollLoopStopsOnAnExpiredStatusWithoutTreatingItAsAFailure() async {
        let job = Fixtures.exportJob(status: .queued)
        api.startExportHandler = { _ in job }
        api.exportJobHandler = { id in Fixtures.exportJob(id: id, status: .expired) }
        let model = ExportViewModel(api: api, eventLogger: EventLogger(api: api), pollInterval: .milliseconds(5))

        await model.start(.fiscalYear(endingIn: 2026))
        try? await Task.sleep(for: .milliseconds(40))

        XCTAssertEqual(model.activeJob?.status, .expired)
    }

    func testAJobStartedAsAlreadyTerminalNeverPolls() async {
        // A history row clicked back into `watch()` can already be
        // `failed`/`expired`/`stale`; tracking it must not schedule a
        // pointless poll loop against a status that will never change.
        var callCount = 0
        api.exportJobHandler = { id in
            callCount += 1
            return Fixtures.exportJob(id: id, status: .stale)
        }
        let model = ExportViewModel(api: api, eventLogger: EventLogger(api: api), pollInterval: .milliseconds(5))

        model.watch(Fixtures.exportJob(status: .stale))
        try? await Task.sleep(for: .milliseconds(40))

        XCTAssertEqual(callCount, 0)
    }

    // MARK: - Rerun

    func testRerunResubmitsTheSameJobsPeriodAsAnExplicitRange() async {
        let expired = Fixtures.exportJob(status: .expired, periodStart: "2025-01-01", periodEnd: "2025-12-31")
        api.startExportHandler = { _ in Fixtures.exportJob(status: .queued) }
        let model = ExportViewModel(api: api, eventLogger: EventLogger(api: api), pollInterval: .seconds(999))

        await model.rerun(expired)

        XCTAssertEqual(api.startExportCalls, [.range(periodStart: "2025-01-01", periodEnd: "2025-12-31")])
    }

    // MARK: - Download (streamed to disk, never held in memory)

    func testDownloadZipMovesTheStreamedFileToAReadyState() async {
        let job = Fixtures.exportJob(status: .complete, downloadUrl: URL(string: "https://example.com/receipts.zip")!)
        // A fake downloader stands in for URLSession: it writes a small
        // local file rather than touching the network, so this test
        // exercises the same "never in memory, always on disk" path the
        // production closure does, deterministically.
        let sourceFile = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        do {
            try "fake zip bytes".data(using: .utf8)!.write(to: sourceFile)
        } catch {
            XCTFail("could not write fixture file: \(error)")
            return
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: sourceFile.path), "fixture file missing right after writing it")
        let response = HTTPURLResponse(
            url: job.downloadUrl!,
            statusCode: 200,
            httpVersion: nil,
            headerFields: ["Content-Disposition": "attachment; filename=\"Receipts-2026.zip\""]
        )!
        let model = ExportViewModel(
            api: api, eventLogger: EventLogger(api: api),
            pollInterval: .seconds(999),
            downloader: { _ in (sourceFile, response) }
        )
        model.watch(job)

        model.downloadZip()
        // The fake downloader returns immediately, but the state update
        // happens after a suspension; give the scheduled task a turn.
        try? await Task.sleep(for: .milliseconds(20))

        guard case .ready(let fileURL) = model.download else {
            XCTFail("expected .ready, got \(model.download)")
            return
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: fileURL.path))
        XCTAssertEqual(fileURL.lastPathComponent, "Receipts-2026.zip")

        // Cleanup mirrors what the share sheet's completion handler does
        // in the app - and it must actually remove the file, not just
        // forget about it.
        model.discardDownloadedFile()
        XCTAssertFalse(FileManager.default.fileExists(atPath: fileURL.path))
        XCTAssertEqual(model.download, .idle)
    }

    func testDownloadZipReportsAFailureForANonSuccessResponse() async {
        let job = Fixtures.exportJob(status: .complete, downloadUrl: URL(string: "https://example.com/receipts.zip")!)
        let sourceFile = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try? Data().write(to: sourceFile)
        let response = HTTPURLResponse(url: job.downloadUrl!, statusCode: 403, httpVersion: nil, headerFields: nil)!
        let model = ExportViewModel(
            api: api, eventLogger: EventLogger(api: api),
            pollInterval: .seconds(999),
            downloader: { _ in (sourceFile, response) }
        )
        model.watch(job)

        model.downloadZip()
        try? await Task.sleep(for: .milliseconds(20))

        XCTAssertNotEqual(model.download, .idle)
        guard case .failed = model.download else {
            XCTFail("expected .failed, got \(model.download)")
            return
        }
    }

    func testCancelDownloadReturnsToIdleAndStopsTheTask() async {
        let job = Fixtures.exportJob(status: .complete, downloadUrl: URL(string: "https://example.com/receipts.zip")!)
        let gate = Gate()
        // A throwaway file of its own, deliberately NOT the temp directory
        // itself: the straggler task below still runs its cancellation
        // cleanup (`removeItem(at: tempURL)`) once the gate opens, and
        // that must only ever delete this one dummy file - reusing the
        // shared temp directory here would let that cleanup delete every
        // other test's temp files out from under them.
        let dummyFile = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try? Data().write(to: dummyFile)
        let model = ExportViewModel(
            api: api, eventLogger: EventLogger(api: api),
            pollInterval: .seconds(999),
            downloader: { url in
                // Blocks until cancelled, standing in for a slow network
                // transfer the person chooses to cancel mid-flight.
                await gate.wait()
                let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!
                return (dummyFile, response)
            }
        )
        model.watch(job)

        model.downloadZip()
        XCTAssertEqual(model.download, .downloading)

        model.cancelDownload()

        XCTAssertEqual(model.download, .idle)
        await gate.open()
    }

    func testStoppingTrackingClearsTheActiveJobAndAnyDownload() async {
        let job = Fixtures.exportJob(status: .queued)
        api.startExportHandler = { _ in job }
        let model = ExportViewModel(api: api, eventLogger: EventLogger(api: api), pollInterval: .seconds(999))
        await model.start(.fiscalYear(endingIn: 2026))

        model.stopTracking()

        XCTAssertNil(model.activeJob)
        XCTAssertEqual(model.download, .idle)
    }
}
