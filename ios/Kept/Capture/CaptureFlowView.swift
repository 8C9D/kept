import SwiftUI

/// The capture journey (spec §7.4): scanner → per-page save into the
/// outbox → straight back to Home. Saving is a local disk write, so this
/// screen is on screen for moments; the outbox uploads behind Home, where
/// queued items show with their status, and confirmation happens from the
/// pending badge once each receipt reaches the server. One receipt or a
/// batch of eighty follows the same path, because a single capture is a
/// batch of one (spec §6A).
struct CaptureFlowView: View {
    private enum Stage {
        case scanning
        case saving
    }

    @StateObject private var captureModel: CaptureFlowModel
    @State private var stage: Stage = .scanning

    /// Called on the way out; true when anything might have changed and
    /// Home should refresh its list.
    private let onFinished: (_ didChangeAnything: Bool) -> Void

    init(outbox: OutboxController, onFinished: @escaping (_ didChangeAnything: Bool) -> Void) {
        _captureModel = StateObject(wrappedValue: CaptureFlowModel(outbox: outbox))
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
