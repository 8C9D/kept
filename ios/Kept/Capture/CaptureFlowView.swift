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
    @State private var stage: Stage = .scanning

    /// Called on the way out; true when anything might have changed and
    /// Home should refresh its list.
    private let onFinished: (_ didChangeAnything: Bool) -> Void

    init(outbox: OutboxController, onFinished: @escaping (_ didChangeAnything: Bool) -> Void) {
        _captureModel = StateObject(wrappedValue: CaptureFlowModel(
            outbox: outbox,
            recognizer: VisionReceiptTextRecognizer()
        ))
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
                    stage = .handlingPages
                    Task { await captureModel.savePages(pages) }
                }
            }
            .ignoresSafeArea()

        case .handlingPages:
            pagesBody
        }
    }

    @ViewBuilder
    private var pagesBody: some View {
        switch captureModel.phase {
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
