import CoreGraphics

/// The pure arithmetic behind the receipt-image zoom sheet (spec §7.2:
/// "tappable to zoom - they must be able to see the paper"; the owner's
/// 2026-08-28 product feedback: it must open fit-to-screen and pinch both
/// in and out from there). Factored out of ZoomableImageView so the
/// numbers can be checked without booting a simulator - the whole reason
/// the previous implementation's bug (opens zoomed in, cannot zoom out)
/// went unnoticed: nothing about "does this fit the screen" was ever
/// asserted anywhere.
enum ZoomScale {
    /// The scale that shows the whole of `imageSize` inside `boundsSize`
    /// with nothing cropped, for any aspect ratio - a receipt shot tall
    /// and narrow, or a squarer PDF page. This is the sheet's opening
    /// scale and its zoomed-out floor (`UIScrollView.minimumZoomScale`):
    /// deliberately not capped at 1, because "the whole receipt on
    /// screen" for an image smaller than the screen means scaled up to
    /// fill it, not stranded small in the middle - the same behaviour
    /// UIScrollView's own built-in fit gives when driven by these values.
    static func fitScale(imageSize: CGSize, in boundsSize: CGSize) -> CGFloat {
        guard imageSize.width > 0, imageSize.height > 0,
              boundsSize.width > 0, boundsSize.height > 0 else {
            // No sensible bounds or a zero-sized image (never real - a
            // decoded UIImage cannot be zero-sized) - 1 is a harmless
            // default a scroll view can still function at.
            return 1
        }
        return min(boundsSize.width / imageSize.width, boundsSize.height / imageSize.height)
    }

    /// The pinch ceiling (`UIScrollView.maximumZoomScale`): a genuinely
    /// useful magnification for reading small print, not a fixed number -
    /// a receipt photographed from further away has a smaller fit scale
    /// (the image is larger relative to the screen) and needs more pinch
    /// range to reach the same readable size than one that already nearly
    /// fills the screen at fit. Floored at 4x so a small or already-large
    /// image still gets a meaningful amount of zoom rather than a ceiling
    /// barely above where it opened.
    static func maximumScale(fitScale: CGFloat) -> CGFloat {
        max(fitScale * 4, 4)
    }
}
