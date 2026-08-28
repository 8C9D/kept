import SwiftUI
import UIKit

/// Where a receipt image's bytes come from: a presigned URL for stored
/// receipts, or the scanned bytes still in memory for a capture being
/// confirmed before it uploads (wave-5 gate ratification).
enum ReceiptImageSource: Equatable {
    case remote(URL)
    case local(Data)
}

/// The confirm screen's inline receipt image: the person is checking
/// numbers against paper, so the image loads eagerly and failures say so.
struct ReceiptImageView: View {
    let source: ReceiptImageSource

    var body: some View {
        switch source {
        case .remote(let url):
            AsyncImage(url: url) { phase in
                switch phase {
                case .empty:
                    CenteredProgressRow()
                case .success(let image):
                    image
                        .resizable()
                        .scaledToFit()
                case .failure:
                    ReceiptImageLoadFailureLabel()
                @unknown default:
                    EmptyView()
                }
            }
        case .local(let data):
            if let uiImage = UIImage(data: data) {
                Image(uiImage: uiImage)
                    .resizable()
                    .scaledToFit()
            } else {
                // The scanner produced these bytes moments ago; failing to
                // re-decode them is stated, same as a failed download.
                ReceiptImageLoadFailureLabel()
            }
        }
    }
}

/// The one "could not load this image" message, shared by the inline view
/// above and the zoom sheet below so the two cannot drift apart.
struct ReceiptImageLoadFailureLabel: View {
    var body: some View {
        Label(
            "The image could not be loaded.",
            systemImage: "photo.badge.exclamationmark"
        )
        .font(.footnote)
        .foregroundStyle(.secondary)
    }
}

/// Tap-to-zoom (spec §7.2: "tappable to zoom - they must be able to see
/// the paper"): pinch to magnify, double-tap to toggle, drag to pan.
///
/// ⚠ The previous implementation (`ScrollView([.horizontal, .vertical])`
/// wrapping a `.scaledToFit()` image, with `scaleEffect` driving a
/// hand-rolled `zoom` value) was diagnosed, not guessed, before this
/// rewrite - two independent bugs, both confirmed by reading the layout
/// and gesture code rather than assumed from the symptom:
///
/// 1. **It opened zoomed in.** Inside a `ScrollView`, content is proposed
///    an *unbounded* size along the axes the scroll view scrolls -
///    `.scaledToFit()` has nothing finite to fit *to* in there, so the
///    image laid out at close to its own intrinsic size (a multi-thousand-
///    pixel photo) rather than the screen's. The `.frame(maxWidth:
///    .infinity, maxHeight: .infinity)` alongside it did nothing to cap
///    this: `maxWidth`/`maxHeight` only clamp a *finite* incoming
///    proposal, and the ScrollView was not offering one.
/// 2. **It could never zoom out past that broken open state.** `zoom` was
///    `min(max(steadyZoom * pinchZoom, 1), 6)` - a hard floor of 1 - so
///    even after fixing (1), pinching out could shrink the image no
///    further than "actual size", which for a tall, narrow receipt is
///    still larger than the screen. The owner asked for "in and out"
///    specifically; the floor made "out" impossible by construction.
///
/// the owner's recommendation is taken as written: this is backed by a real
/// `UIScrollView` via `UIViewRepresentable` (see ZoomableImageView.swift)
/// rather than another SwiftUI-`ScrollView`-plus-`scaleEffect` attempt.
/// `UIScrollView` computes `minimumZoomScale`/`maximumZoomScale` against
/// its own bounds explicitly - the fit is a value this code sets, not one
/// that emerges from how a proposal happens to flow through a stack of
/// modifiers - and centring, bounce, pan clamping and double-tap-to-zoom
/// come from the platform rather than being reimplemented by hand.
struct ZoomableImageSheet: View {
    let source: ReceiptImageSource
    /// `image_zoomed` (behavioural telemetry, 2026-08-28) - called at most
    /// once per sheet presentation, the first time the person actually
    /// zooms in past the fit scale (Coordinator.scrollViewDidZoom below).
    /// Nil by default so a caller with no EventLogger in hand - there is
    /// none today, but this view should not require one - simply logs
    /// nothing.
    var onZoomed: (() -> Void)? = nil

    @Environment(\.dismiss) private var dismiss
    @State private var loadedImage: UIImage?
    @State private var loadFailed = false

    var body: some View {
        NavigationStack {
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color(uiColor: .systemBackground))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Done") { dismiss() }
                    }
                }
                // Keyed on the source so a sheet reused for a different
                // image (not how this is presented today, but the sheet
                // should not depend on that) reloads rather than showing
                // the previous image's bytes.
                .task(id: source) {
                    await load()
                }
        }
    }

    @ViewBuilder
    private var content: some View {
        if let loadedImage {
            ZoomableImageView(image: loadedImage, onZoomed: onZoomed)
                // The scroll view owns safe-area handling itself (its
                // content is meant to run edge to edge while zoomed); the
                // toolbar above still reserves its own space.
                .ignoresSafeArea(edges: [.horizontal, .bottom])
        } else if loadFailed {
            ReceiptImageLoadFailureLabel()
        } else {
            CenteredProgressRow()
        }
    }

    /// Resolves the source to a `UIImage` the representable can hand
    /// straight to a `UIScrollView` - decoded once here rather than
    /// inside `AsyncImage`, which hands back an opaque SwiftUI `Image`
    /// with no supported way to recover the `UIImage` a zoom view needs.
    private func load() async {
        loadedImage = nil
        loadFailed = false
        switch source {
        case .local(let data):
            loadedImage = UIImage(data: data)
            loadFailed = loadedImage == nil
        case .remote(let url):
            do {
                let (data, _) = try await URLSession.shared.data(from: url)
                loadedImage = UIImage(data: data)
                loadFailed = loadedImage == nil
            } catch {
                loadFailed = true
            }
        }
    }
}

/// A `UIScrollView` sized and zoomed against its *own* laid-out bounds -
/// the thing a SwiftUI `ScrollView` never exposes and the reason the
/// previous attempt could not compute a correct fit. See the
/// `ZoomableImageSheet` doc comment above for the fuller diagnosis.
struct ZoomableImageView: UIViewRepresentable {
    let image: UIImage
    var onZoomed: (() -> Void)? = nil

    func makeUIView(context: Context) -> UIScrollView {
        let scrollView = FitTrackingScrollView()
        scrollView.delegate = context.coordinator
        scrollView.showsHorizontalScrollIndicator = false
        scrollView.showsVerticalScrollIndicator = false
        scrollView.bouncesZoom = true
        scrollView.contentInsetAdjustmentBehavior = .never
        scrollView.backgroundColor = .clear

        let imageView = UIImageView(image: image)
        imageView.contentMode = .scaleAspectFit
        imageView.frame = CGRect(origin: .zero, size: image.size)
        scrollView.addSubview(imageView)
        scrollView.contentSize = image.size
        context.coordinator.imageView = imageView

        // Fires on every real layout pass, rotation included - not just
        // the one SwiftUI happens to drive via updateUIView, which would
        // miss a bounds change from a rotation that changes no SwiftUI
        // state (spec requirement: rotation returns to a correct fit).
        scrollView.onLayout = { [weak scrollView, coordinator = context.coordinator] in
            guard let scrollView else { return }
            coordinator.applyFitIfBoundsChanged(to: scrollView, imageSize: image.size)
        }

        let doubleTap = UITapGestureRecognizer(
            target: context.coordinator,
            action: #selector(Coordinator.handleDoubleTap(_:))
        )
        doubleTap.numberOfTapsRequired = 2
        scrollView.addGestureRecognizer(doubleTap)

        return scrollView
    }

    /// Nothing to push in on an ordinary SwiftUI re-render: `image` is
    /// fixed for this view's lifetime (a changed source presents a fresh
    /// sheet - and so a fresh representable - rather than updating this
    /// one in place). All the real work happens in `makeUIView` and the
    /// layout-driven callback wired there.
    func updateUIView(_ uiView: UIScrollView, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onZoomed: onZoomed) }

    @MainActor
    final class Coordinator: NSObject, UIScrollViewDelegate {
        fileprivate weak var imageView: UIImageView?
        /// The bounds size the current fit was computed for. Guards
        /// `applyFitIfBoundsChanged` so an unrelated layout pass mid-pinch
        /// or mid-pan (UIScrollView calls `layoutSubviews` on scroll, not
        /// only on resize) never stomps the person's zoom - only an
        /// actual size change (first layout, or rotation) does.
        private var lastFitBoundsSize: CGSize = .zero
        private let onZoomed: (() -> Void)?
        /// `image_zoomed` fires at most once per sheet presentation - a
        /// pinch gesture reports many `scrollViewDidZoom` calls a second,
        /// and the event exists to say "this person zoomed", not to count
        /// how many frames it took.
        private var hasReportedZoom = false

        init(onZoomed: (() -> Void)?) {
            self.onZoomed = onZoomed
        }

        func viewForZooming(in scrollView: UIScrollView) -> UIView? {
            imageView
        }

        func scrollViewDidZoom(_ scrollView: UIScrollView) {
            centerImage(in: scrollView)
            // A small epsilon above the fit scale, same tolerance
            // handleDoubleTap below already uses: setZoomScale/pinching
            // rarely lands on the exact float minimumZoomScale computes.
            if !hasReportedZoom && scrollView.zoomScale > scrollView.minimumZoomScale + 0.01 {
                hasReportedZoom = true
                onZoomed?()
            }
        }

        @objc func handleDoubleTap(_ gesture: UITapGestureRecognizer) {
            guard let scrollView = gesture.view as? UIScrollView else { return }
            // A small epsilon rather than exact equality: setZoomScale is
            // not guaranteed to land on the exact float requested.
            let isZoomedIn = scrollView.zoomScale > scrollView.minimumZoomScale + 0.01
            scrollView.setZoomScale(
                isZoomedIn ? scrollView.minimumZoomScale : scrollView.maximumZoomScale,
                animated: true
            )
        }

        func applyFitIfBoundsChanged(to scrollView: UIScrollView, imageSize: CGSize) {
            let boundsSize = scrollView.bounds.size
            guard boundsSize.width > 0, boundsSize.height > 0, boundsSize != lastFitBoundsSize else {
                return
            }
            lastFitBoundsSize = boundsSize

            let fit = ZoomScale.fitScale(imageSize: imageSize, in: boundsSize)
            scrollView.minimumZoomScale = fit
            scrollView.maximumZoomScale = ZoomScale.maximumScale(fitScale: fit)
            scrollView.zoomScale = fit
            centerImage(in: scrollView)
        }

        /// The classic UIScrollView zoom-centring trick: as `zoomScale`
        /// changes, UIKit resizes the view `viewForZooming` returns to
        /// `contentSize`-at-zoomScale automatically, but leaves it pinned
        /// to the top-left rather than centred - recentring it whenever it
        /// is smaller than the viewport is this method's whole job, on
        /// both axes independently (a very wide, short image can be
        /// letterboxed on one axis and filled on the other at the same
        /// time).
        private func centerImage(in scrollView: UIScrollView) {
            guard let imageView else { return }
            let boundsSize = scrollView.bounds.size
            var frame = imageView.frame
            frame.origin.x = frame.width < boundsSize.width ? (boundsSize.width - frame.width) / 2 : 0
            frame.origin.y = frame.height < boundsSize.height ? (boundsSize.height - frame.height) / 2 : 0
            imageView.frame = frame
        }
    }
}

/// A `UIScrollView` that reports every real layout pass, not only the
/// ones SwiftUI happens to drive through `updateUIView` - the hook
/// `ZoomableImageView` needs to notice a rotation (a bounds change with no
/// SwiftUI state change behind it) and recompute the fit for it.
private final class FitTrackingScrollView: UIScrollView {
    var onLayout: (() -> Void)?

    override func layoutSubviews() {
        super.layoutSubviews()
        onLayout?()
    }
}
