import SwiftUI

/// The capture journey, split by the wave-5 gate ratification:
///
/// - **One page**: scanner → on-device read → the §7.2 confirm screen,
///   right there, because confirming in the moment is the §1 success
///   test. Its Save is a durable disk write into the outbox (a confirmed
///   receipt; the upload happens behind Home), so nothing here ever waits
///   on the network. "Later" queues it pending instead.
/// - **A batch**: every page queues pending immediately and Home returns
///   at once; the stack is worked down through the confirm queue
///   afterwards (spec §6A).
struct CaptureFlowView: View {
    private enum Stage {
        case scanning
        case handlingPages
    }

    @StateObject private var captureModel: CaptureFlowModel
    /// The capture-time confirm offers whatever the last options fetch
    /// cached; this screen never asks for a fresh one (it is the offline
    /// path by design).
    @ObservedObject private var options: ReceiptOptionsStore
    private let eventLogger: EventLogger
    @State private var stage: Stage = .scanning

    /// Called on the way out; true when anything might have changed and
    /// Home should refresh its list.
    private let onFinished: (_ didChangeAnything: Bool) -> Void

    init(
        api: any KeptAPI,
        outbox: OutboxController,
        options: ReceiptOptionsStore,
        eventLogger: EventLogger,
        onFinished: @escaping (_ didChangeAnything: Bool) -> Void
    ) {
        _captureModel = StateObject(wrappedValue: CaptureFlowModel(
            outbox: outbox,
            recognizer: VisionReceiptTextRecognizer(),
            // The vendor heuristic's known-vendor pass reads the person's
            // own past names out of the same cached options this screen
            // already offers as pickable values (2026-09-01) - cached, so
            // still no network on the capture path.
            knownVendors: { [weak options] in options?.options.vendors ?? [] },
            // The server's second opinion (2026-09-01). Everything about
            // the screen still works with this returning nothing, forever:
            // see CaptureFlowModel.requestSecondOpinion.
            remoteParse: { ocrRawText, capturedAt in
                let result = try await api.parseReceiptText(ocrRawText: ocrRawText, capturedAt: capturedAt)
                return result.suggestions.asReceiptSuggestions
            }
        ))
        self.options = options
        self.eventLogger = eventLogger
        self.onFinished = onFinished
    }

    var body: some View {
        switch stage {
        case .scanning:
            DocumentScannerView { outcome in
                switch outcome {
                case .cancelled:
                    eventLogger.log(.captureCancelled)
                    onFinished(false)
                case .failed:
                    // The scanner failing before any page exists leaves
                    // nothing to save or retry; leaving quietly and letting
                    // the person re-tap Capture beats a dead-end alert.
                    // Not `.captureCancelled` - the person did not choose
                    // this - but the vocabulary has no third outcome for
                    // "the scanner itself errored", and losing that
                    // distinction in telemetry is the accepted trade.
                    onFinished(false)
                case .scanned(let pages):
                    eventLogger.log(.captureCompleted, count: pages.count)
                    stage = .handlingPages
                    Task { await captureModel.savePages(pages) }
                }
            }
            .ignoresSafeArea()
            .onAppear {
                eventLogger.log(.captureStarted)
            }

        case .handlingPages:
            pagesBody
        }
    }

    @ViewBuilder
    private var pagesBody: some View {
        switch captureModel.phase {
        case .choosingPageMode(let pageCount):
            ScannedPagesChoiceView(pageCount: pageCount) {
                Task { await captureModel.saveScannedPagesAsSeparateReceipts() }
            } onOneReceipt: {
                Task { await captureModel.saveScannedPagesAsOneReceipt() }
            }

        case .idle, .reading:
            VStack(spacing: 12) {
                ProgressView()
                Text("Reading receipt…")
                    .font(.headline)
                Text("On this device - no connection needed.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

        case .confirming(let confirmModel):
            NavigationStack {
                ConfirmReceiptView(
                    model: confirmModel,
                    options: options,
                    eventLogger: eventLogger,
                    onSaved: {
                        // The saveAction already queued the confirmed
                        // receipt durably; straight back to Home, no
                        // success modal (§10A.1).
                        captureModel.finishSingleCapture()
                    },
                    onSetAside: {
                        await captureModel.setAsideSingleCapture()
                    }
                )
            }
            .interactiveDismissDisabled()

        case .saving:
            VStack(spacing: 12) {
                ProgressView()
                if case .saving(let pageNumber, let pageCount) = captureModel.phase {
                    Text("Saving receipt \(pageNumber) of \(pageCount)…")
                        .font(.headline)
                }
                Text("Saved on this phone; uploads on its own.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

        case .failed(let message):
            failedBody(message)

        case .saved:
            // Straight back to Home - the receipts are safe in the outbox,
            // and no success modal, ever (§10A.1).
            Color.clear.onAppear {
                onFinished(true)
            }
        }
    }

    private func failedBody(_ message: String) -> some View {
        VStack(spacing: 12) {
            Label("Save failed", systemImage: "exclamationmark.triangle")
                .font(.headline)
            Text(message)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button("Try again") {
                Task { await captureModel.retry() }
            }
            .buttonStyle(.borderedProminent)
            Button("Give up on the rest") {
                // Pages already saved are queued in the outbox and shown
                // on Home; finishing here loses only the unsaved scans -
                // and the paper is still in hand.
                onFinished(true)
            }
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// The question a multi-page scanning session has to answer before either
/// path can start (2026-09-01, the owner's decision): N separate receipts -
/// the backlog case this app was built for - or one receipt with N pages.
///
/// The scanner cannot tell them apart, and guessing either way is
/// destructive: "separate" splits a folio into halves that each look like
/// a receipt with a missing total, and "one" silently swallows a stack of
/// eighty into a single row. So the one person who knows is asked, once.
///
/// Deliberately a SCREEN rather than a `confirmationDialog`: a dialog
/// always offers Cancel, and there is no honest cancel here. The pages are
/// scanned, unsaved, and the paper may already be back in a pocket - every
/// way out of this has to end with them queued (wave-5 kickoff §1: a scan
/// is never lost to a tap).
///
/// Its own type rather than a branch inside the flow above so it can be
/// laid out and looked at without a camera; the simulator has neither one
/// nor a way to present `VNDocumentCameraViewController` at all.
struct ScannedPagesChoiceView: View {
    let pageCount: Int
    let onSeparateReceipts: () -> Void
    let onOneReceipt: () -> Void

    init(
        pageCount: Int,
        onSeparateReceipts: @escaping () -> Void,
        onOneReceipt: @escaping () -> Void
    ) {
        self.pageCount = pageCount
        self.onSeparateReceipts = onSeparateReceipts
        self.onOneReceipt = onOneReceipt
    }

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "doc.on.doc")
                .font(.largeTitle)
                .foregroundStyle(.secondary)
            Text("\(pageCount) pages scanned")
                .font(.headline)
            Text("A stack scanned back to back is several receipts. A folio or a bill that ran onto a second sheet is one.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button(action: onSeparateReceipts) {
                Text("Save as \(pageCount) separate receipts")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .accessibilityIdentifier("pages.separate")
            Button(action: onOneReceipt) {
                Text("One receipt with \(pageCount) pages")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("pages.oneReceipt")
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
