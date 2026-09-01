import PDFKit
import SwiftUI

/// Rendering a receipt that is a PDF rather than a photograph
/// (2026-09-01, the iOS PDF import).
///
/// An emailed receipt arrives as a PDF and is stored as one - the bytes
/// the person was sent, not a re-rendered picture of them, because a tax
/// record's evidence is the document itself. `UIImage(data:)` cannot
/// decode those bytes and `AsyncImage` fails on them, so every screen that
/// shows a receipt image needs a second renderer. This is it: PDFKit's own
/// `PDFView`, which brings paging, pinch zoom and text selection with it
/// rather than having any of that reimplemented here (the same reasoning
/// §4.2 uses for VisionKit's scanner).
///
/// The routing is deliberately inside `ReceiptImageView` and
/// `ZoomableImageSheet` rather than at their call sites: the confirm
/// screen, the detail screen's page list and the zoom sheet all show
/// whatever a receipt happens to be, and a call site that had to know
/// which renderer to pick is a call site that will one day pick wrong.
extension ReceiptImageSource {
    /// The four bytes every PDF starts with (`%PDF`), per ISO 32000's
    /// header rule.
    private static let pdfHeader = Data("%PDF".utf8)

    /// Whether these bytes are a PDF document rather than an image.
    ///
    /// Two different questions behind one answer, because the two sources
    /// know different things:
    /// - **Remote**: the object key's extension, which the server assigns
    ///   from the presigned content type (`.pdf` for `application/pdf`) -
    ///   the bytes are not in hand and downloading them to find out would
    ///   defeat the point of asking. Read off the path, never the whole
    ///   URL, so a presigned query string cannot make an image look like a
    ///   PDF.
    /// - **Local**: the bytes themselves, which are right there. A
    ///   filename would be a guess where the header is a fact.
    var isPDF: Bool {
        switch self {
        case .remote(let url):
            return url.path(percentEncoded: false).lowercased().hasSuffix(".pdf")
        case .local(let data):
            return data.prefix(Self.pdfHeader.count) == Self.pdfHeader
        }
    }
}

/// A receipt PDF, fetched if it is remote and handed to PDFKit.
///
/// The download runs in the view's own `task`, off the main thread, and
/// the bytes are what reach `PDFDocument(data:)` - never `PDFDocument(url:)`
/// on a presigned URL, which does its network work synchronously wherever
/// it is called and would freeze the screen for the length of it.
struct PDFReceiptView: View {
    let source: ReceiptImageSource
    /// Continuous scrolling for the inline views (a two-page folio reads
    /// as one strip); single-page with PDFKit's own paging in the zoom
    /// sheet, where a page at a time is the point.
    var displaysAsSinglePage = false

    @State private var data: Data?
    @State private var loadFailed = false

    var body: some View {
        Group {
            if let data {
                PDFKitDocumentView(data: data, displaysAsSinglePage: displaysAsSinglePage)
            } else if loadFailed {
                ReceiptImageLoadFailureLabel()
            } else {
                CenteredProgressRow()
            }
        }
        // Keyed on the source, like the zoom sheet's own loader: a view
        // reused for a different document reloads rather than showing the
        // previous one's bytes.
        .task(id: source) {
            await load()
        }
    }

    private func load() async {
        data = nil
        loadFailed = false
        switch source {
        case .local(let bytes):
            data = bytes
        case .remote(let url):
            do {
                let (downloaded, _) = try await URLSession.shared.data(from: url)
                data = downloaded
            } catch {
                loadFailed = true
            }
        }
    }
}

/// `PDFView` for SwiftUI. Nothing but plumbing, deliberately (spec §10.2):
/// every decision that could live elsewhere - which source is a PDF, where
/// the bytes come from - already does, and what is left is the four
/// property assignments PDFKit needs.
struct PDFKitDocumentView: UIViewRepresentable {
    let data: Data
    var displaysAsSinglePage: Bool

    func makeUIView(context: Context) -> PDFView {
        let view = PDFView()
        // Scales the page to the view's own bounds and keeps doing so
        // through rotation - the same fit-to-bounds behaviour
        // ZoomableImageView computes by hand for a photograph, which
        // PDFKit already owns for a document.
        view.autoScales = true
        view.displayMode = displaysAsSinglePage ? .singlePage : .singlePageContinuous
        view.displayDirection = .vertical
        view.backgroundColor = .clear
        // Parsed here, on the main thread, from bytes already in memory:
        // the parse is lazy and the file is a receipt, not an atlas. What
        // must never happen on the main thread is the DOWNLOAD, which is
        // why `PDFReceiptView` above fetches first and this takes `Data`
        // rather than a URL.
        view.document = PDFDocument(data: data)
        context.coordinator.loadedData = data
        return view
    }

    func updateUIView(_ view: PDFView, context: Context) {
        // A view reused for different bytes (the zoom sheet's page
        // buttons) must not keep showing the old document. Compared
        // against what the coordinator recorded rather than against
        // `view.document` - PDFKit re-serializes on
        // `dataRepresentation()`, so a document's bytes back out are not
        // the bytes that went in and the check would re-parse on every
        // layout pass.
        guard context.coordinator.loadedData != data else { return }
        view.document = PDFDocument(data: data)
        context.coordinator.loadedData = data
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    @MainActor
    final class Coordinator {
        var loadedData: Data?
    }
}
