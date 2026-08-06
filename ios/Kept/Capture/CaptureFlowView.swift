import SwiftUI

/// The whole capture journey in one full-screen presentation: scanner →
/// per-page saving → the confirm queue → back to Home. One receipt or a
/// batch of eighty follows the same path, because a single capture is a
/// batch of one (spec §6A).
struct CaptureFlowView: View {
    private enum Stage {
        case scanning
        case saving
        case confirming
    }

    @StateObject private var captureModel: CaptureFlowModel
    @StateObject private var queue: ConfirmQueueModel
    @State private var stage: Stage = .scanning

    /// Called on the way out; true when anything might have changed and
    /// Home should refresh its list.
    private let onFinished: (_ didChangeAnything: Bool) -> Void

    init(api: APIClient, onFinished: @escaping (_ didChangeAnything: Bool) -> Void) {
        _captureModel = StateObject(wrappedValue: CaptureFlowModel(
            api: api,
            recognizer: VisionReceiptTextRecognizer()
        ))
        _queue = StateObject(wrappedValue: ConfirmQueueModel(api: api))
        self.onFinished = onFinished
    }

    var body: some View {
        switch stage {
        case .scanning:
            DocumentScannerView { outcome in
                switch outcome {
                case .cancelled:
                    onFinished(false)
                case .failed:
                    // The scanner failing before any page exists leaves
                    // nothing to save or retry; leaving quietly and letting
                    // the person re-tap Capture beats a dead-end alert.
                    onFinished(false)
                case .scanned(let pages):
                    stage = .saving
                    Task { await captureModel.savePages(pages) }
                }
            }
            .ignoresSafeArea()

        case .saving:
            savingBody

        case .confirming:
            NavigationStack {
                ConfirmQueueView(queue: queue) {
                    onFinished(true)
                }
            }
            .interactiveDismissDisabled()
        }
    }

    @ViewBuilder
    private var savingBody: some View {
        switch captureModel.phase {
        case .idle, .saving:
            VStack(spacing: 12) {
                ProgressView()
                if case .saving(let pageNumber, let pageCount) = captureModel.phase, pageCount > 1 {
                    Text("Saving receipt \(pageNumber) of \(pageCount)…")
                        .font(.headline)
                } else {
                    Text("Saving receipt…")
                        .font(.headline)
                }
                Text("Reading the text on device.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

        case .failed(let message):
            failedBody(message)

        case .saved:
            // Straight into confirming - no success modal, ever (§10A.1).
            Color.clear.onAppear {
                stage = .confirming
                Task { await queue.loadNext() }
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
                // Pages already saved are pending receipts; the queue
                // still offers them, so finishing here loses only the
                // unsaved scans - and the paper is still in hand.
                onFinished(true)
            }
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
