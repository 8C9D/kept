import SwiftUI

/// The screen an import runs behind (2026-09-01): a progress line per
/// file, a failure that names the file and offers retry from there, and a
/// close that leaves whatever landed queued.
///
/// Structurally the small sibling of `CaptureFlowView`'s batch phase, and
/// worded from the same rule: the receipts are safe on this phone the
/// moment they are queued, and the upload is the app's problem from then
/// on (spec §7.4). Nothing here waits on the network.
struct PDFImportView: View {
    @StateObject private var importModel: PDFImportModel
    private let urls: [URL]
    /// Called on the way out; true when anything was queued and Home
    /// should refresh.
    private let onFinished: (_ didImportAnything: Bool) -> Void

    init(
        outbox: OutboxController,
        options: ReceiptOptionsStore,
        urls: [URL],
        onFinished: @escaping (_ didImportAnything: Bool) -> Void
    ) {
        _importModel = StateObject(wrappedValue: PDFImportModel(
            outbox: outbox,
            // The same cached vendor list the capture screen reads, for
            // the same reason: it is only ever consulted on the
            // scanned-PDF fallback, and this path must work with no
            // network.
            knownVendors: { [weak options] in options?.options.vendors ?? [] }
        ))
        self.urls = urls
        self.onFinished = onFinished
    }

    var body: some View {
        NavigationStack {
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .navigationTitle("Import PDFs")
                .navigationBarTitleDisplayMode(.inline)
        }
        .interactiveDismissDisabled()
        .task {
            await importModel.importFiles(urls)
        }
    }

    /// Names the files, because "a file was too long" with no name is
    /// not something anyone can act on.
    static func truncationNote(_ files: [String]) -> String {
        let names = files.joined(separator: ", ")
        let subject = files.count == 1
            ? "\(names) is longer than the server accepts"
            : "\(names) are longer than the server accepts"
        return "\(subject), so only the first \(PDFReceiptText.maxCharacters) characters of its text were sent. The receipt is queued and its document is stored whole - only the text the parser reads was shortened."
    }

    @ViewBuilder
    private var content: some View {
        switch importModel.phase {
        case .idle:
            ProgressView()

        case .importing(let fileNumber, let fileCount):
            VStack(spacing: 12) {
                ProgressView()
                Text(fileCount > 1 ? "Importing \(fileNumber) of \(fileCount)…" : "Importing…")
                    .font(.headline)
                Text("Saved on this phone; uploads on its own.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

        case .failed(let message):
            VStack(spacing: 12) {
                Label("Import failed", systemImage: "exclamationmark.triangle")
                    .font(.headline)
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                Button("Try again") {
                    Task { await importModel.retry() }
                }
                .buttonStyle(.borderedProminent)
                Button("Give up on the rest") {
                    // Whatever already queued is safe and shows on Home;
                    // finishing here loses only the files not yet read,
                    // and they are still in Files.
                    onFinished(true)
                }
            }
            .padding()

        case .finished(let count, let truncatedFiles) where truncatedFiles.isEmpty:
            // Straight back to Home, no success modal (§10A.1) - the
            // receipts are in the queue, which is where Home shows them.
            Color.clear.onAppear {
                onFinished(count > 0)
            }

        case .finished(let count, let truncatedFiles):
            // Not a success modal, which §10A.1 forbids: a partial
            // outcome, which it does not. Every one of these receipts IS
            // queued - what is being stated is that one of them carries
            // only part of its document's text, which a person confirming
            // it later would otherwise have no way to know.
            VStack(spacing: 12) {
                Label("Imported, with one thing to know", systemImage: "info.circle")
                    .font(.headline)
                Text(Self.truncationNote(truncatedFiles))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                Button("Done") {
                    onFinished(count > 0)
                }
                .buttonStyle(.borderedProminent)
            }
            .padding()
        }
    }
}
