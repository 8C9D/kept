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
        /// One JPEG per scanned page, in scan order.
        case scanned([Data])
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

    final class Coordinator: NSObject, VNDocumentCameraViewControllerDelegate {
        private let completion: (Outcome) -> Void

        init(completion: @escaping (Outcome) -> Void) {
            self.completion = completion
        }

        func documentCameraViewController(
            _ controller: VNDocumentCameraViewController,
            didFinishWith scan: VNDocumentCameraScan
        ) {
            var pages: [Data] = []
            for pageIndex in 0..<scan.pageCount {
                guard let jpeg = scan.imageOfPage(at: pageIndex).jpegData(compressionQuality: DocumentScannerView.jpegQuality) else {
                    // A page that cannot encode is a lost scan; surface it
                    // rather than silently uploading fewer receipts than
                    // were scanned.
                    completion(.failed(PageEncodingError(pageIndex: pageIndex)))
                    return
                }
                pages.append(jpeg)
            }
            if !pages.isEmpty {
                AudioServicesPlaySystemSound(DocumentScannerView.shutterSoundID)
            }
            completion(.scanned(pages))
        }

        func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
            completion(.cancelled)
        }

        func documentCameraViewController(
            _ controller: VNDocumentCameraViewController,
            didFailWithError error: Error
        ) {
            completion(.failed(error))
        }

        struct PageEncodingError: LocalizedError {
            let pageIndex: Int
            var errorDescription: String? {
                "Page \(pageIndex + 1) could not be encoded as an image."
            }
        }
    }
}
