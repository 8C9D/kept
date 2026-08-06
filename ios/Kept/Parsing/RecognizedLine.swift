import Foundation

/// One line of text recognized on a receipt, reduced to exactly what the
/// parsing heuristics need: the text, where the line sits vertically, and
/// how tall it is.
///
/// This type is the boundary between the camera plumbing and the parser
/// (spec §10.2): Vision hands the plumbing observations in its own
/// bottom-left-origin normalized coordinates, and the plumbing converts
/// them to this deliberately simpler shape. The parser never sees a Vision
/// type, which is what makes it unit-testable on the simulator against
/// hand-written fixtures.
struct RecognizedLine: Equatable {
    let text: String

    /// The vertical center of the line, normalized to the receipt image:
    /// 0 is the top edge, 1 is the bottom edge. §7.3's "top third",
    /// "top quarter", and "lower third" heuristics read this directly.
    let verticalCenter: Double

    /// The line's height as a fraction of the image height - the parser's
    /// proxy for font size. §7.3's vendor heuristic ("the largest-font
    /// text block in the top quarter") compares these.
    let height: Double

    /// The horizontal center, 0 at the left edge to 1 at the right. Used
    /// by ReceiptRowAssembler to order fragments within a printed row -
    /// thermal receipts print "Subtotal" and its amount as two separate
    /// observations with a wide gap between them (wave-4 device run).
    let horizontalCenter: Double

    init(text: String, verticalCenter: Double, height: Double, horizontalCenter: Double = 0.5) {
        self.text = text
        self.verticalCenter = verticalCenter
        self.height = height
        self.horizontalCenter = horizontalCenter
    }
}
