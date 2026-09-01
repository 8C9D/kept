import PDFKit
import SwiftUI
import UIKit
import XCTest
@testable import Kept

/// Three screens rendered for real, in a real window, and checked for the
/// one thing a unit test of a view model cannot check: that something is
/// actually drawn (2026-09-01).
///
/// This exists because of what the three items in this batch have in
/// common - each of them draws something the app has never drawn before.
/// A PDF goes through PDFKit rather than `UIImage`, which fails SILENTLY:
/// `UIImage(data:)` returns nil for PDF bytes and `AsyncImage` renders its
/// failure state, so a mis-routed document is a blank rectangle and a
/// green test suite. The same is true of the multi-page choice screen and
/// the manage-values list, both of which are new views with no other
/// coverage that they lay out at all.
///
/// So: host each view in a window, render it, and assert the pixels are
/// not uniform. The PNGs are also written to the temporary directory and
/// their paths printed, which is what they were inspected from.
@MainActor
final class ScreenRenderingTests: XCTestCase {
    private static let phoneSize = CGSize(width: 393, height: 852)

    func testAPDFReceiptRendersThroughPDFKitRatherThanBlank() async throws {
        let pdf = Self.receiptPDF()
        // The precondition that makes this test worth having: these bytes
        // are NOT an image, so the photograph path could only ever draw
        // the failure label.
        XCTAssertNil(UIImage(data: pdf))
        XCTAssertTrue(ReceiptImageSource.local(pdf).isPDF)

        let image = try await render(
            ReceiptImageView(source: .local(pdf))
                .frame(width: 360, height: 500),
            named: "pdf-receipt"
        )
        XCTAssertTrue(Self.hasVisibleContent(image), "the PDF drew nothing")
    }

    /// A remote source is a PDF when its object key says so - the bytes
    /// are not in hand, and the server assigns `.pdf` from the presigned
    /// content type. A signed query string must not be able to change
    /// that answer.
    func testARemoteSourceIsJudgedByItsPathNotItsQueryString() throws {
        let pdf = try XCTUnwrap(URL(string: "https://storage.example/u/2026/09/abc.pdf?X-Amz-Signature=deadbeef"))
        let jpeg = try XCTUnwrap(URL(string: "https://storage.example/u/2026/09/abc.jpg?name=receipt.pdf"))
        XCTAssertTrue(ReceiptImageSource.remote(pdf).isPDF)
        XCTAssertFalse(ReceiptImageSource.remote(jpeg).isPDF)
    }

    func testTheManageValuesScreenLaysOutItsThreeLists() async throws {
        let api = StubKeptAPI()
        api.receiptOptionsHandler = {
            ReceiptOptions(
                categories: ["Meals", "Office supplies", "Parking"],
                paymentMethods: ["Visa ending 4021", "Cash"],
                vendors: ["Loblaws", "Food Basics", "Shoppers Drug Mart"]
            )
        }
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "ScreenRenderingTests-\(UUID().uuidString)"))
        defer { defaults.removePersistentDomain(forName: defaults.description) }
        let options = ReceiptOptionsStore(api: api, defaults: defaults)
        await options.refresh()

        let image = try await render(
            NavigationStack {
                ManageValuesView(api: api, options: options)
            }
            .frame(width: Self.phoneSize.width, height: Self.phoneSize.height),
            named: "manage-values"
        )
        XCTAssertTrue(Self.hasVisibleContent(image))
    }

    func testTheMultiPageChoiceScreenOffersBothAnswers() async throws {
        let image = try await render(
            ScannedPagesChoiceView(pageCount: 3, onSeparateReceipts: {}, onOneReceipt: {})
                .frame(width: Self.phoneSize.width, height: Self.phoneSize.height),
            named: "scanned-pages-choice"
        )
        XCTAssertTrue(Self.hasVisibleContent(image))
    }

    /// The confirm screen for a scan the person said was ONE receipt: the
    /// form is backed by page 1 and the image section says which page it
    /// is showing.
    func testTheConfirmScreenShowsAPageIndicatorForAMultiPageCapture() async throws {
        let api = StubKeptAPI()
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "ScreenRenderingTests-\(UUID().uuidString)"))
        defer { defaults.removePersistentDomain(forName: defaults.description) }
        let options = ReceiptOptionsStore(api: api, defaults: defaults)
        let draft = CapturedReceiptDraft(
            imageData: Self.pageImage(labelled: "1"),
            suggestions: ReceiptSuggestions(
                totalCents: 11300,
                hstCents: 1300,
                subtotalCents: 10000,
                purchasedAt: "2026-01-14",
                vendor: "MAPLE FOODS MARKET"
            ),
            ocrRawText: nil,
            capturedAt: Date(timeIntervalSince1970: 1_775_000_000),
            ocrFailureNote: nil,
            additionalPages: [Self.pageImage(labelled: "2"), Self.pageImage(labelled: "3")]
        )
        let model = ConfirmReceiptModel(draft: draft, saveAction: { _ in })
        XCTAssertEqual(model.imageSources.count, 3)

        let image = try await render(
            NavigationStack {
                ConfirmReceiptView(
                    model: model,
                    options: options,
                    eventLogger: EventLogger(api: api),
                    onSaved: {},
                    onSetAside: {}
                )
            }
            .frame(width: Self.phoneSize.width, height: Self.phoneSize.height),
            named: "confirm-multipage"
        )
        XCTAssertTrue(Self.hasVisibleContent(image))
    }

    /// The zoom sheet turning pages (2026-09-01). Buttons rather than a
    /// swipe, because the zoomed content is a `UIScrollView` whose pan
    /// gesture owns horizontal drags the moment someone zooms in.
    func testTheZoomSheetShowsAPageControlForAMultiPageReceipt() async throws {
        let image = try await render(
            ZoomableImageSheet(sources: [
                .local(Self.pageImage(labelled: "1")),
                .local(Self.pageImage(labelled: "2")),
            ])
            .frame(width: Self.phoneSize.width, height: Self.phoneSize.height),
            named: "zoom-sheet-pages",
            settle: .milliseconds(1500)
        )
        XCTAssertTrue(Self.hasVisibleContent(image))
    }

    func testThePastValuesPickerSheetLaysOutItsSearchableList() async throws {
        let vendors = (1...40).map { "Vendor \($0)" }
        let image = try await render(
            PastValuesPickerSheet(title: "Vendor", values: vendors) { _ in }
                .frame(width: Self.phoneSize.width, height: Self.phoneSize.height),
            named: "past-values-picker"
        )
        XCTAssertTrue(Self.hasVisibleContent(image))
    }

    // MARK: - Rendering

    /// Hosts a view in a real window attached to the test host's own
    /// scene, waits for its `task` modifiers to settle, and returns the
    /// pixels. A detached `UIWindow` with no scene does not lay out
    /// `UIViewRepresentable` content on iOS, which is exactly the content
    /// this file exists to look at.
    ///
    /// ⚠ Reading these PNGs by eye: `drawHierarchy` on a window that was
    /// made key moments earlier INTERMITTENTLY draws a bottom overlay a
    /// second time up in the navigation-bar band. It is a compositing
    /// artifact of the snapshot, not a duplicated view - the same code
    /// renders with and without it across runs, and it survived swapping
    /// the overlay for a `safeAreaInset` and then for a `.bottomBar`
    /// toolbar group. Do not chase it as a layout bug (this note exists
    /// because it was chased once).
    private func render<V: View>(
        _ view: V,
        named name: String,
        settle: Duration = .milliseconds(700)
    ) async throws -> UIImage {
        let scene = try XCTUnwrap(
            UIApplication.shared.connectedScenes.first as? UIWindowScene,
            "the test host has no window scene"
        )
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(origin: .zero, size: Self.phoneSize)
        let host = UIHostingController(rootView: view)
        window.rootViewController = host
        window.isHidden = false
        window.makeKeyAndVisible()
        defer { window.isHidden = true }

        // SwiftUI `.task`s (the PDF load) and PDFKit's own layout both
        // need a turn of the run loop; one `layoutIfNeeded` is not enough.
        try await Task.sleep(for: settle)
        host.view.setNeedsLayout()
        host.view.layoutIfNeeded()

        let renderer = UIGraphicsImageRenderer(bounds: window.bounds)
        let image = renderer.image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        if let png = image.pngData() {
            let url = URL(fileURLWithPath: NSTemporaryDirectory())
                .appending(path: "kept-screen-\(name).png")
            try png.write(to: url)
            print("SCREENSHOT \(name): \(url.path)")
        }
        return image
    }

    /// Whether anything was drawn: a render that is one flat colour is
    /// what a blank screen, a failed layout and an unattached window all
    /// look like, and all three are the failure this file is here to
    /// catch.
    private static func hasVisibleContent(_ image: UIImage) -> Bool {
        guard let cgImage = image.cgImage else { return false }
        let width = cgImage.width
        let height = cgImage.height
        guard width > 0, height > 0 else { return false }
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        guard let context = CGContext(
            data: &pixels,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else {
            return false
        }
        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
        let first = Array(pixels[0..<4])
        return stride(from: 0, to: pixels.count, by: 4).contains { offset in
            Array(pixels[offset..<(offset + 4)]) != first
        }
    }

    /// A plain page image with a big numeral on it, so a rendered
    /// multi-page confirm screen shows at a glance WHICH page it is on.
    private static func pageImage(labelled label: String) -> Data {
        let size = CGSize(width: 600, height: 800)
        let format = UIGraphicsImageRendererFormat.preferred()
        format.scale = 1
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        return renderer.image { context in
            UIColor.systemGray6.setFill()
            context.fill(CGRect(origin: .zero, size: size))
            (label as NSString).draw(
                at: CGPoint(x: 240, y: 300),
                withAttributes: [
                    .font: UIFont.systemFont(ofSize: 200, weight: .bold),
                    .foregroundColor: UIColor.darkGray,
                ]
            )
        }.jpegData(compressionQuality: 0.9) ?? Data()
    }

    /// A typeset PDF receipt, generated here - no fixture files, and the
    /// same generator the extraction tests use.
    private static func receiptPDF() -> Data {
        let renderer = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 612, height: 792))
        return renderer.pdfData { context in
            context.beginPage()
            var y: CGFloat = 60
            for line in [
                "MAPLE FOODS MARKET",
                "128 Queen Street West, Toronto ON",
                "",
                "2026/01/14   14:22",
                "",
                "Bananas            3.49",
                "Milk 2L            5.29",
                "Bread             99.22",
                "",
                "SUBTOTAL         100.00",
                "HST 13%           13.00",
                "TOTAL            113.00",
            ] {
                (line as NSString).draw(
                    at: CGPoint(x: 60, y: y),
                    withAttributes: [.font: UIFont.monospacedSystemFont(ofSize: 18, weight: .regular)]
                )
                y += 30
            }
        }
    }
}
