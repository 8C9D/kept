import SwiftUI
import UIKit

/// The export screen. **the owner asked for this on 2026-08-28**, and it is a
/// deliberate, ratified reversal of spec §4.1a and §7.1, which put export
/// on the web client only and said in as many words "resist adding a
/// sixth [screen]". **That reasoning was never refuted and is not being
/// relitigated here** - a year-end zip can reach the byte budget's ~890
/// MB peak, and generating one over cellular on the device with the least
/// storage, only to share it off again, is still the wrong default place
/// to do that. The owner has asked for it anyway, which is his call to make,
/// and the job of this screen is to honour that original concern rather
/// than ignore it: `ExportViewModel.downloadZip()` streams the finished
/// zip to a temporary file through a `URLSession` download task and never
/// holds it in memory, which is the specific failure §4.1a was worried
/// about. §7.1's screen count will be amended by a separate documentation
/// pass (this file does not touch docs/) - **this comment is the marker
/// until it is, so a future reader does not "fix" this back to web-only.**
///
/// Beyond that: this screen computes nothing (spec §4.1). It asks the
/// server for a period, polls the job the server runs, and hands the
/// person the finished file - fiscal-period math, the zip's contents, and
/// the byte budget all stay the server's, exactly as `server/src/routes/
/// exports.ts` and the already-shipped web client (`web/src/views/
/// ExportView.tsx`) already do it.
struct ExportView: View {
    @StateObject private var model: ExportViewModel

    @State private var fiscalYear = Calendar.current.component(.year, from: Date())
    @State private var rangeStart: Date?
    @State private var rangeEnd: Date?
    /// Proposal #10's preset picker (2026-08-28): which of the six presets
    /// is currently selected - a plain view-owned value, the same shape
    /// `fiscalYear`/`rangeStart`/`rangeEnd` above already are, since this
    /// is UI input state, not something the model fetches or derives.
    @State private var preset: PeriodPreset = .lastFiscalYear
    /// Computed once, at this view's init, never re-read - the identical
    /// choice `web/src/views/ExportView.tsx`'s own `useMemo` makes, for
    /// the identical reason (its own comment): a stable "today" costs
    /// nothing and keeps the preset picker from silently reflowing under
    /// someone mid-choice on a session that spans a midnight rollover.
    @State private var today = FiscalPresets.todayCalendarDate(now: Date())

    init(api: APIClient, eventLogger: EventLogger) {
        _model = StateObject(wrappedValue: ExportViewModel(api: api, eventLogger: eventLogger))
    }

    var body: some View {
        Form {
            explanationSection
            startersSection
            if let job = model.activeJob {
                activeJobSection(job)
            }
            historySection
        }
        .navigationTitle("Export")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await model.loadHistory()
        }
        .task {
            await model.loadProfile()
        }
        .alert(
            "The export could not be started",
            isPresented: Binding(
                get: { model.startOutcome.failureMessage != nil },
                set: { if !$0 { model.clearStartFailure() } }
            )
        ) {
            Button("OK", role: .cancel) {
                model.clearStartFailure()
            }
        } message: {
            Text(model.startOutcome.failureMessage ?? "")
        }
        // The finished zip's temp file, handed to a share sheet - Files,
        // AirDrop and Mail all copy the bytes onward from there, so the
        // temp file is discarded (ExportViewModel.discardDownloadedFile())
        // the moment the sheet reports it is done, whatever the person
        // chose to do with it.
        .sheet(isPresented: Binding(
            get: { model.download.readyURL != nil },
            set: { if !$0 { model.discardDownloadedFile() } }
        )) {
            if let url = model.download.readyURL {
                ActivityShareSheet(url: url) {
                    model.discardDownloadedFile()
                }
            }
        }
    }

    // MARK: - Explanation

    private var explanationSection: some View {
        Section {
            Text("A zip with your receipts and every image, named for the period you pick. Links last 30 days - after that, run the period again; your receipts are the record, the zip is regenerable from them.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Starters

    private var startersSection: some View {
        Section("Start a new export") {
            if let message = model.startOutcome.alreadyRunningMessage {
                // A specific, explained outcome (spec §8: refused, not
                // queued) rather than a generic failure - shown near the
                // controls it blocks, with History (below) already
                // refreshed to the running job.
                Label(message, systemImage: "clock.badge.exclamationmark")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            }

            VStack(alignment: .leading, spacing: 8) {
                Stepper(value: $fiscalYear, in: 2000...2100) {
                    Text("Fiscal year ending in \(String(fiscalYear))")
                }
                Button("Export fiscal year") {
                    Task { await model.start(.fiscalYear(endingIn: fiscalYear)) }
                }
                .disabled(isStarting)
            }
            .padding(.vertical, 4)

            VStack(alignment: .leading, spacing: 8) {
                rangeRow(title: "From", date: $rangeStart)
                rangeRow(title: "To", date: $rangeEnd)
                Button("Export range") {
                    guard let rangeStart, let rangeEnd else { return }
                    Task {
                        await model.start(.range(
                            periodStart: ReceiptFormat.isoDate(fromPicker: rangeStart),
                            periodEnd: ReceiptFormat.isoDate(fromPicker: rangeEnd)
                        ))
                    }
                }
                .disabled(isStarting || rangeStart == nil || rangeEnd == nil)
            }
            .padding(.vertical, 4)

            presetStarter
        }
    }

    /// Proposal #10's third starter, over the two above: a picker among
    /// the six presets, the RESOLVED range shown before generating
    /// anything (the proposal's own requirement - an export names its own
    /// period in its filename, §8), and one button. Hidden entirely until
    /// `model.profile` loads rather than rendered against a guessed year
    /// end - `resolvedPreset`'s own doc comment states why. Mirrors
    /// `web/src/views/ExportView.tsx`'s identical starter (read-only
    /// reference), including the ordering: after the two pre-existing
    /// starters, never before them.
    @ViewBuilder
    private var presetStarter: some View {
        if let resolvedPreset {
            VStack(alignment: .leading, spacing: 8) {
                Picker("Period", selection: $preset) {
                    ForEach(PeriodPreset.allCases) { option in
                        Text(option.label).tag(option)
                    }
                }
                Text("\(ReceiptFormat.purchaseDate(resolvedPreset.range.start)) – \(ReceiptFormat.purchaseDate(resolvedPreset.range.end))")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Button("Export period") {
                    Task { await model.start(resolvedPreset.request) }
                }
                .disabled(isStarting)
            }
            .padding(.vertical, 4)
        }
    }

    /// The currently-selected preset, resolved against THIS user's own
    /// fiscal year end - nil exactly when `model.profile` has not loaded
    /// (yet, or ever), which is what keeps `presetStarter` above hidden
    /// rather than wrong.
    private var resolvedPreset: ResolvedPreset? {
        guard let profile = model.profile else { return nil }
        return resolvePreset(
            preset,
            today: today,
            fiscalYearEnd: FiscalYearEnd(month: profile.fiscalYearEndMonth, day: profile.fiscalYearEndDay)
        )
    }

    private var isStarting: Bool {
        model.startOutcome == .starting
    }

    /// One date bound, same shape as DateRangeFilterSheet's: a picker once
    /// set, a button to set it - reused here rather than copied blind,
    /// pinned to the same UTC frame the receipt-date picker uses so a
    /// range typed here means the same calendar day the server sees.
    @ViewBuilder
    private func rangeRow(title: String, date: Binding<Date?>) -> some View {
        if let value = date.wrappedValue {
            DatePicker(
                title,
                selection: Binding(get: { value }, set: { date.wrappedValue = $0 }),
                displayedComponents: .date
            )
            .receiptDatePickerPin()
        } else {
            Button("Set the \(title.lowercased()) date") {
                date.wrappedValue = ReceiptFormat.pickerDate(
                    fromIso: ReceiptFormat.isoDate(fromPicker: Date())
                ) ?? Date()
            }
        }
    }

    // MARK: - Active job (spec §8's six states, rendered as themselves)

    @ViewBuilder
    private func activeJobSection(_ job: ExportJob) -> some View {
        Section("This export") {
            VStack(alignment: .leading, spacing: 6) {
                Text("\(ReceiptFormat.purchaseDate(job.periodStart)) – \(ReceiptFormat.purchaseDate(job.periodEnd))")
                    .font(.headline)
                statusContent(job)
            }
            .padding(.vertical, 4)
        }
    }

    @ViewBuilder
    private func statusContent(_ job: ExportJob) -> some View {
        switch job.status {
        case .queued:
            Label("Queued - waiting to start.", systemImage: "clock")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        case .running:
            HStack(spacing: 8) {
                ProgressView()
                Text("Generating your export…")
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)
        case .complete:
            completeContent
        case .failed:
            // The server's own words, shown verbatim (spec §8): an
            // oversized export says to export a shorter period, a missing
            // image names the receipt id and the remedy this app cannot
            // improve on by rewording it.
            Label(job.error ?? "The export failed.", systemImage: "exclamationmark.triangle")
                .font(.subheadline)
                .foregroundStyle(.red)
        case .expired:
            VStack(alignment: .leading, spacing: 8) {
                Text("This export's link has expired - links last 30 days.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Button("Run this period again") {
                    Task { await model.rerun(job) }
                }
            }
        case .stale:
            VStack(alignment: .leading, spacing: 8) {
                Text("This export was lost before finishing, most likely because the server restarted.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Button("Run this period again") {
                    Task { await model.rerun(job) }
                }
            }
        }
    }

    /// The person is told what they are about to download (the period, in
    /// the section header above) before anything starts, and nothing
    /// starts until they tap Download - the closest this screen gets to a
    /// confirmation, deliberately not a modal on top of that (spec
    /// §10A.1's house style: state it, do not dialog it).
    @ViewBuilder
    private var completeContent: some View {
        switch model.download {
        case .idle:
            VStack(alignment: .leading, spacing: 8) {
                Text("Ready to download.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Button("Download") {
                    model.downloadZip()
                }
            }
        case .downloading:
            HStack(spacing: 8) {
                ProgressView()
                Text("Downloading…")
                Spacer()
                Button("Cancel", role: .cancel) {
                    model.cancelDownload()
                }
            }
            .font(.subheadline)
        case .failed(let message):
            VStack(alignment: .leading, spacing: 8) {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.red)
                Button("Try the download again") {
                    model.downloadZip()
                }
            }
        case .ready:
            // The share sheet is already up via this view's own .sheet;
            // nothing further to show in the row underneath it.
            EmptyView()
        }
    }

    // MARK: - History

    @ViewBuilder
    private var historySection: some View {
        Section("Recent exports") {
            if let historyError = model.historyError {
                LoadFailureView(message: historyError) {
                    await model.loadHistory()
                }
            } else if model.history.isEmpty {
                Text("No exports yet.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(model.history) { job in
                    Button {
                        model.watch(job)
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("\(ReceiptFormat.purchaseDate(job.periodStart)) – \(ReceiptFormat.purchaseDate(job.periodEnd))")
                                Text(job.status.label)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            if model.activeJob?.id == job.id {
                                Image(systemName: "checkmark")
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}

/// Proposal #10 (approved, docs/proposals/2026-08-28-ux-enhancements.md
/// #10): the six presets over the two pre-existing starters (fiscal year
/// number, explicit range). Mirrors `web/src/views/ExportView.tsx`'s
/// identical `PeriodPreset` one for one, including the label text, so the
/// two clients cannot drift on what "Q1" or "this fiscal year to date"
/// means.
enum PeriodPreset: String, CaseIterable, Identifiable, Hashable {
    case lastFiscalYear, yearToDate, q1, q2, q3, q4

    var id: String { rawValue }

    var label: String {
        switch self {
        case .lastFiscalYear: return "Last fiscal year"
        case .yearToDate: return "This fiscal year to date"
        case .q1: return "Q1"
        case .q2: return "Q2"
        case .q3: return "Q3"
        case .q4: return "Q4"
        }
    }
}

/// A preset resolved against one user's fiscal year end: what to show
/// (`range`) and exactly what starting it sends (`request`).
struct ResolvedPreset: Equatable {
    let range: DateRange
    let request: ExportRequest
}

/// Mirrors `web/src/views/ExportView.tsx`'s identical `resolvePreset`
/// (read-only reference) line for line. "Last fiscal year" prefers
/// `{fiscalYearEndingIn}` and lets the SERVER derive the actual dates
/// (§4.1a, §5.1) - `range` here is a preview only, computed the same way
/// purely so it can be shown before generating anything (proposal #10's
/// own requirement); it is not what gets sent. The other three presets
/// have no `{fiscalYearEndingIn}` equivalent (the API only derives a whole
/// fiscal year that way, never a quarter or a to-date slice), so `range`
/// IS the request for those - computed once, sent unchanged.
func resolvePreset(
    _ preset: PeriodPreset,
    today: CalendarDate,
    fiscalYearEnd fye: FiscalYearEnd
) -> ResolvedPreset {
    switch preset {
    case .lastFiscalYear:
        let result = FiscalPresets.lastFiscalYear(today: today, fiscalYearEnd: fye)
        return ResolvedPreset(range: result.range, request: .fiscalYear(endingIn: result.endYear))
    case .yearToDate:
        let range = FiscalPresets.fiscalYearToDate(today: today, fiscalYearEnd: fye)
        return ResolvedPreset(range: range, request: .range(periodStart: range.start, periodEnd: range.end))
    case .q1:
        let range = FiscalPresets.fiscalQuarters(today: today, fiscalYearEnd: fye).q1
        return ResolvedPreset(range: range, request: .range(periodStart: range.start, periodEnd: range.end))
    case .q2:
        let range = FiscalPresets.fiscalQuarters(today: today, fiscalYearEnd: fye).q2
        return ResolvedPreset(range: range, request: .range(periodStart: range.start, periodEnd: range.end))
    case .q3:
        let range = FiscalPresets.fiscalQuarters(today: today, fiscalYearEnd: fye).q3
        return ResolvedPreset(range: range, request: .range(periodStart: range.start, periodEnd: range.end))
    case .q4:
        let range = FiscalPresets.fiscalQuarters(today: today, fiscalYearEnd: fye).q4
        return ResolvedPreset(range: range, request: .range(periodStart: range.start, periodEnd: range.end))
    }
}

private extension ExportJobStatus {
    /// Display text for the history list - purely presentational, unlike
    /// `job.error` above, which the server wrote for a person and is
    /// never replaced with wording of this app's own.
    var label: String {
        switch self {
        case .queued: return "Queued"
        case .running: return "Generating…"
        case .complete: return "Ready to download"
        case .failed: return "Failed"
        case .expired: return "Expired - re-run for a fresh copy"
        case .stale: return "Lost before finishing - re-run"
        }
    }
}

private extension ExportViewModel.DownloadState {
    /// The local file URL while a finished download is sitting ready for
    /// a share sheet - nil in every other state. Gives the view's sheet
    /// binding one thing to test instead of pattern-matching the enum
    /// inline at each call site.
    var readyURL: URL? {
        if case .ready(let url) = self { return url }
        return nil
    }
}

/// A UIKit share sheet for one local file. Files, AirDrop and Mail all
/// copy the bytes onward once chosen, which is why the caller discards
/// its temp file the moment `onFinished` fires - whether the person
/// picked an activity or just dismissed the sheet, `completionWithItemsHandler`
/// fires either way, so cleanup is not gated on success.
private struct ActivityShareSheet: UIViewControllerRepresentable {
    let url: URL
    let onFinished: () -> Void

    func makeUIViewController(context: Context) -> UIActivityViewController {
        let controller = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        controller.completionWithItemsHandler = { _, _, _, _ in
            onFinished()
        }
        return controller
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}
