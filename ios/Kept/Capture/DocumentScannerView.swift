import AudioToolbox
import SwiftUI
import VisionKit

/// Apple's document scanner, wrapped for SwiftUI. This is the single
/// biggest reason native was chosen (spec §4.2): edge detection,
/// perspective correction, glare handling - none of it is ours to build
/// or maintain.
///
/// The scanner naturally captures many pages in one session, which is
/// batch mode (spec §6A): the person scans a stack back to back, and each
/// page becomes its own pending receipt downstream. A single receipt is
/// just a batch of one.
///
/// This file is deliberately nothing but plumbing (spec §10.2): the
/// simulator has no camera, so nothing here is testable off-device, and
/// every decision that can live elsewhere does. Pages leave as plain JPEG
/// bytes so nothing downstream needs UIKit.
struct DocumentScannerView: UIViewControllerRepresentable {
    enum Outcome {
        /// The person tapped Save and the pages are being encoded. Arrives
        /// at once, so the screen can move on while that runs (2026-10-31).
        case encoding
        case scanned(ScannedPages)
        case cancelled
        case failed(Error)
    }

    /// JPEG quality for captured pages: a receipt photograph around a
    /// megabyte - text stays crisp for the zoom-to-check interaction while
    /// a sixty-receipt backlog session does not upload gigabytes.
    /// nonisolated: an immutable constant the (nonisolated) delegate reads;
    /// the view struct's inferred MainActor isolation is irrelevant to it.
    private nonisolated static let jpegQuality: CGFloat = 0.8

    /// The system camera shutter (`photoShutter`, 2026-09-01). Played once
    /// per scanning session, when the session ends with at least one page.
    ///
    /// **It is deliberately not once per page, and cannot be.**
    /// `VNDocumentCameraViewController`'s entire public surface is three
    /// terminal delegate calls - `didFinishWith`, `didCancel`,
    /// `didFailWithError` (checked against the iOS 26.2 SDK header) - and
    /// `VNDocumentCameraScan` is handed over only at the end, with `init`
    /// unavailable, so there is nothing to observe or KVO while the camera
    /// is up. The only per-page signal that exists at all is the private
    /// view hierarchy of a system view controller: its page counter, read
    /// by polling and matched on its text. That is not an API, it is
    /// archaeology - it degrades to silence when Apple relabels the
    /// control and to spurious clicks when it relabels it into something
    /// that still matches - and none of it could be exercised before
    /// shipping, because the simulator has no camera and reports
    /// `isSupported == false`, so the scanner cannot even be presented off
    /// a device. A per-page shutter needs a camera we own, i.e. replacing
    /// VisionKit - which is the one thing this app deliberately does not
    /// do (spec §4.2). One honest click at the end beats a guess that
    /// clicks at the wrong times.
    ///
    /// `AudioServicesPlaySystemSound` follows the ring/silent switch: on a
    /// phone in silent this makes no sound. That is the correct behaviour
    /// for an app - the Camera app overrides it in some regions for legal
    /// reasons, which is an entitlement this app has no business wanting.
    private nonisolated static let shutterSoundID: SystemSoundID = 1108

    let completion: (Outcome) -> Void

    static var isSupported: Bool {
        VNDocumentCameraViewController.isSupported
    }

    func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
        let controller = VNDocumentCameraViewController()
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: VNDocumentCameraViewController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(completion: completion)
    }

    /// What crosses to the encoding task. `VNDocumentCameraScan` is not
    /// Sendable and neither is the completion, but the scan is read only by
    /// that task and the completion is only ever called back on the main
    /// actor, which is where it came from. Reading the scan off the main
    /// thread is the shape Apple's own document-scanning sample uses.
    private struct ScanHandoff: @unchecked Sendable {
        let scan: VNDocumentCameraScan
        let completion: (Outcome) -> Void
    }

    final class Coordinator: NSObject, VNDocumentCameraViewControllerDelegate {
        private let completion: (Outcome) -> Void
        /// The delegate returns immediately now, so the scanner stays alive
        /// and tappable for as long as the encoding takes.
        private var hasFinished = false

        init(completion: @escaping (Outcome) -> Void) {
            self.completion = completion
        }

        /// Hands the pages to a background task rather than encoding them
        /// here (2026-10-31). This runs on the main thread, and a scanned
        /// page is a full-resolution image: a stack froze the UI for the
        /// length of the encode, and every decoded page stayed in memory
        /// until the run loop turned, which is a jetsam risk on a long
        /// batch. It costs no time: the same work, in the same order,
        /// starting at once, and the screen moves on as it starts.
        func documentCameraViewController(
            _ controller: VNDocumentCameraViewController,
            didFinishWith scan: VNDocumentCameraScan
        ) {
            guard !hasFinished else { return }
            hasFinished = true
            if scan.pageCount > 0 {
                AudioServicesPlaySystemSound(DocumentScannerView.shutterSoundID)
            }
            completion(.encoding)

            let handoff = ScanHandoff(scan: scan, completion: completion)
            Task.detached(priority: .userInitiated) {
                let pages = ScannedPages.encode(pageCount: handoff.scan.pageCount) { pageIndex in
                    handoff.scan.imageOfPage(at: pageIndex)
                        .jpegData(compressionQuality: DocumentScannerView.jpegQuality)
                }
                await MainActor.run {
                    handoff.completion(.scanned(pages))
                }
            }
        }

        func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
            guard !hasFinished else { return }
            completion(.cancelled)
        }

        func documentCameraViewController(
            _ controller: VNDocumentCameraViewController,
            didFailWithError error: Error
        ) {
            guard !hasFinished else { return }
            completion(.failed(error))
        }
    }
}

/// What one scanning session produced: the pages that became JPEGs, in scan
/// order, and the ones that did not (2026-10-31).
///
/// Before this, one page that would not encode failed the whole session -
/// every good page of a stack gone, and the caller leaves quietly on
/// `.failed`, so nobody was told either. The paper may already be back in a
/// pocket, so what encoded is kept and the page that did not is named.
///
/// Outside `DocumentScannerView` so the rule can run in a test: the
/// simulator cannot present the scanner at all.
struct ScannedPages: Equatable, Sendable {
    let pages: [Data]
    /// 1-based, as a person counts them.
    let failedPageNumbers: [Int]

    /// Stated wherever the surviving pages go next, or nil when every page
    /// made it - the ordinary case, which says nothing.
    var failureNote: String? {
        guard !failedPageNumbers.isEmpty else { return nil }
        let scanned = pages.count + failedPageNumbers.count
        let named = failedPageNumbers.map(String.init).joined(separator: ", ")
        return failedPageNumbers.count == 1
            ? "Page \(named) of \(scanned) could not be saved. Scan it again."
            : "Pages \(named) of \(scanned) could not be saved. Scan them again."
    }

    /// Each page inside its own pool, so a page's decoded image is released
    /// before the next is decoded and a stack costs one page of peak memory
    /// rather than all of them. `encodePage` is nil for a page that failed.
    static func encode(pageCount: Int, encodePage: (Int) -> Data?) -> ScannedPages {
        var pages: [Data] = []
        var failed: [Int] = []
        for pageIndex in 0..<pageCount {
            if let jpeg = autoreleasepool(invoking: { encodePage(pageIndex) }) {
                pages.append(jpeg)
            } else {
                failed.append(pageIndex + 1)
            }
        }
        return ScannedPages(pages: pages, failedPageNumbers: failed)
    }
}
