import XCTest
@testable import Kept

/// The zoom sheet's pure arithmetic: what "fit the whole receipt on
/// screen" and "a genuinely useful magnification" mean as numbers, for
/// every aspect ratio a receipt or a PDF page can have. This is exactly
/// what the previous implementation never had a test for - it opened
/// zoomed in because nothing here asserted what "fit" should compute to.
final class ZoomScaleTests: XCTestCase {
    // MARK: - fitScale

    func testFitScaleShrinksATallNarrowReceiptToFitTheScreensHeight() {
        // A receipt photo far taller than it is wide, in a portrait
        // screen - the height ratio is the binding constraint.
        let scale = ZoomScale.fitScale(
            imageSize: CGSize(width: 1000, height: 4000),
            in: CGSize(width: 400, height: 800)
        )
        // width ratio: 400/1000 = 0.4, height ratio: 800/4000 = 0.2 - fit
        // takes the smaller so nothing is cropped off either edge.
        XCTAssertEqual(scale, 0.2, accuracy: 0.0001)
    }

    func testFitScaleShrinksAWidePDFPageToFitTheScreensWidth() {
        // A landscape-oriented page - the width ratio now binds instead.
        let scale = ZoomScale.fitScale(
            imageSize: CGSize(width: 2000, height: 500),
            in: CGSize(width: 400, height: 800)
        )
        // width ratio: 400/2000 = 0.2, height ratio: 800/500 = 1.6 - fit
        // is still the smaller of the two.
        XCTAssertEqual(scale, 0.2, accuracy: 0.0001)
    }

    func testFitScaleUpscalesAnImageSmallerThanTheScreen() {
        // "The whole receipt on screen" for a small image means filling
        // the screen, not leaving it stranded small in the middle -
        // deliberately not capped at 1.
        let scale = ZoomScale.fitScale(
            imageSize: CGSize(width: 100, height: 100),
            in: CGSize(width: 400, height: 800)
        )
        XCTAssertEqual(scale, 4.0, accuracy: 0.0001)
    }

    func testFitScaleDefaultsToOneForAZeroSizedInput() {
        // Never real for a decoded image, but a bounds size can
        // momentarily be zero before a view's first layout pass; the
        // function must not divide by zero or crash.
        XCTAssertEqual(ZoomScale.fitScale(imageSize: .zero, in: CGSize(width: 400, height: 800)), 1)
        XCTAssertEqual(ZoomScale.fitScale(imageSize: CGSize(width: 100, height: 100), in: .zero), 1)
    }

    // MARK: - maximumScale

    func testMaximumScaleIsFourTimesFitWhenThatExceedsTheFloor() {
        XCTAssertEqual(ZoomScale.maximumScale(fitScale: 2), 8)
    }

    func testMaximumScaleFloorsAtFourForATinyFitScale() {
        // A receipt shot from far away has a small fit scale (the image
        // is huge relative to the screen); 4x that would barely move the
        // pinch range, so the floor guarantees a real amount of zoom.
        XCTAssertEqual(ZoomScale.maximumScale(fitScale: 0.1), 4)
    }

    func testMaximumScaleAlwaysExceedsFitScale() {
        // The invariant UIScrollView needs: maximumZoomScale must never be
        // less than minimumZoomScale, whatever the fit turns out to be.
        for fit: CGFloat in [0.01, 0.2, 1, 2.5, 10] {
            XCTAssertGreaterThan(ZoomScale.maximumScale(fitScale: fit), fit)
        }
    }
}
