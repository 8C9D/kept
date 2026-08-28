import SwiftUI

/// The scan-then-upload journey for adding a page or replacing one's
/// image (proposal #6, 2026-08-28) - the same `VNDocumentCameraViewController`
/// scanner the capture flow uses (spec §4.2: not a raw `AVCaptureSession`),
/// followed by ReceiptImageUploadModel's upload sequence. Structurally the
/// small sibling of CaptureFlowView: scan, then work, then report back -
/// but with no confirm screen in between, because nothing here is a new
/// receipt with fields to confirm.
struct ReceiptImageUploadView: View {
    /// Which of the two actions this presentation is for. Both share one
    /// model and one screen because the only real difference is which
    /// ReceiptImageUploadModel method the scan result feeds.
    enum Mode {
        case add
        case replace(page: Int)

        var navigationTitle: String {
            switch self {
            case .add: return "Add a page"
            case .replace: return "Replace image"
            }
        }

        var failureTitle: String {
            switch self {
            case .add: return "The page could not be added"
            case .replace: return "The image could not be replaced"
            }
        }
    }

    private enum Stage {
        case scanning
        case working
    }

    @StateObject private var uploadModel: ReceiptImageUploadModel
    private let mode: Mode
    /// Runs on the way out; true when a page actually landed and the
    /// receipt detail screen should reload to show it (spec: refresh from
    /// the server after any change rather than hand-mutating local state).
    private let onFinished: (_ didChangeAnything: Bool) -> Void

    @State private var stage: Stage = .scanning
    /// Set when a replace scan returned more than one page - only the
    /// first replaces the image; the rest are named here rather than
    /// silently dropped, since silently dropping scanned pages is exactly
    /// the kind of invisible data loss this app avoids elsewhere.
    @State private var discardedExtraPagesNote: String?

    init(
        api: any KeptAPI,
        eventLogger: EventLogger,
        receiptId: UUID,
        mode: Mode,
        onFinished: @escaping (_ didChangeAnything: Bool) -> Void
    ) {
        _uploadModel = StateObject(wrappedValue: ReceiptImageUploadModel(
            api: api,
            eventLogger: eventLogger,
            receiptId: receiptId
        ))
        self.mode = mode
        self.onFinished = onFinished
    }

    var body: some View {
        NavigationStack {
            Group {
                switch stage {
                case .scanning:
                    DocumentScannerView { outcome in
                        switch outcome {
                        case .cancelled, .failed:
                            // Nothing was scanned; the receipt is exactly
                            // as it was, so there is nothing to reload.
                            onFinished(false)
                        case .scanned(let pages):
                            stage = .working
                            Task { await start(with: pages) }
                        }
                    }
                    .ignoresSafeArea()
                case .working:
                    workingBody
                }
            }
            .navigationTitle(mode.navigationTitle)
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private func start(with pages: [Data]) async {
        switch mode {
        case .add:
            await uploadModel.addPages(pages)
        case .replace(let page):
            if pages.count > 1 {
                discardedExtraPagesNote = pages.count == 2
                    ? "One extra scanned page was not used. Use \"Add a page\" for it."
                    : "\(pages.count - 1) extra scanned pages were not used. Use \"Add a page\" for them."
            }
            await uploadModel.replacePage(page, data: pages[0])
        }
    }

    @ViewBuilder
    private var workingBody: some View {
        switch uploadModel.phase {
        case .idle:
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .uploading(let pageNumber, let pageCount):
            VStack(spacing: 12) {
                ProgressView()
                Text(pageCount > 1 ? "Uploading page \(pageNumber) of \(pageCount)…" : "Uploading…")
                    .font(.headline)
                // §7.4 is the capture outbox's guarantee, not this
                // screen's: this needs a connection now, and says so,
                // rather than queuing silently the way a new capture
                // would.
                Text("This needs a connection - it isn't queued for later like a new capture.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal)
                if let discardedExtraPagesNote {
                    Text(discardedExtraPagesNote)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed(let message):
            VStack(spacing: 12) {
                Label(mode.failureTitle, systemImage: "exclamationmark.triangle")
                    .font(.headline)
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                Button("Try again") {
                    Task { await uploadModel.retry() }
                }
                .buttonStyle(.borderedProminent)
                Button("Cancel", role: .cancel) {
                    // Reload regardless: an earlier page in a batch may
                    // already have landed server-side even though this
                    // one failed, and reloading an unchanged receipt
                    // costs nothing (the same trade CaptureFlowView's own
                    // "Give up on the rest" makes).
                    onFinished(true)
                }
            }
            .padding()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .finished:
            Color.clear.onAppear {
                onFinished(true)
            }
        }
    }
}
