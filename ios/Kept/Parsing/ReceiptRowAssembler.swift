import Foundation

/// Reassembles Vision's text fragments into the rows a person sees.
///
/// Thermal receipts - which is to say most receipts - print a label on the
/// left and its amount on the right with a wide gap between them, and
/// Vision reports the two as separate observations. Every §7.3 heuristic
/// matches a label and an amount within one string, so without this step
/// "Subtotal" and "13.50" can never meet: on the wave-4 device receipt,
/// subtotal and HST failed to parse for exactly this reason while every
/// contiguously-printed field succeeded.
///
/// Two steps, both earned on real receipts:
///
/// 1. **De-skew the amount column.** A photographed receipt is rarely
///    flat or square to the lens, so the right-hand column's measured
///    vertical centers can sit a near-constant offset from the labels
///    they belong to - one coherent, receipt-wide skew, not per-row
///    noise. The wave-5 device receipt measured its amounts ~0.013 above
///    their labels against a row pitch of ~0.022: each amount's *nearest*
///    label was the wrong one, so no proximity threshold could pair that
///    tax block correctly ("GST $0.00 / HST $2.05 / Total $17.84" read as
///    "GST $2.05 / HST $17.84" with the ends orphaned - three different
///    wrong HST suggestions from one receipt). The estimator: the median
///    of each right-column fragment's vertical delta to its nearest
///    other-column neighbour - robust because most nearest pairings are
///    true pairings even under skew. The correction applies to grouping
///    only; emitted rows keep the measured geometry.
/// 2. **Band-merge.** Fragments whose (de-skewed) vertical centers sit
///    within half the taller fragment's height of a row's running center
///    belong to that row; a row's text is its fragments joined left to
///    right.
///
/// Honest limit: a skew approaching a full row pitch would shift every
/// pairing by exactly one row, which no local geometry can detect - the
/// de-skew handles the partial-pitch case that actually occurs, and the
/// human confirming every value remains the real safety (constraint 2).
enum ReceiptRowAssembler {
    /// Fragments at or right of this are the "amount column" for skew
    /// estimation: on both real receipts so far, amounts sit past 0.8 and
    /// labels before 0.55, while full-width lines centre near 0.5 and
    /// must count as label-side context, not amounts.
    private static let amountColumnThreshold = 2.0 / 3.0
    /// Fewer nearest-neighbour samples than this and the median is
    /// noise; the skew stays zero and behaviour is wave-4's exactly.
    private static let minimumSkewSamples = 3

    static func assembleRows(_ fragments: [RecognizedLine]) -> [RecognizedLine] {
        let skew = columnSkew(of: fragments)

        // The de-skewed center steers grouping; the fragment itself, with
        // its measured geometry, is what rows are built from.
        let ordered = fragments
            .map { fragment in
                (fragment: fragment, bandCenter: bandCenter(of: fragment, skew: skew))
            }
            .sorted { $0.bandCenter < $1.bandCenter }

        var rows: [[(fragment: RecognizedLine, bandCenter: Double)]] = []
        for entry in ordered {
            if var currentRow = rows.last {
                let center = currentRow.map(\.bandCenter).reduce(0, +) / Double(currentRow.count)
                let tallest = currentRow.map(\.fragment.height).max() ?? 0
                let tolerance = 0.5 * max(entry.fragment.height, tallest)
                if abs(entry.bandCenter - center) <= tolerance {
                    currentRow.append(entry)
                    rows[rows.count - 1] = currentRow
                    continue
                }
            }
            rows.append([entry])
        }

        return rows.compactMap { mergeRow($0.map(\.fragment)) }
    }

    private static func bandCenter(of fragment: RecognizedLine, skew: Double) -> Double {
        fragment.horizontalCenter >= amountColumnThreshold
            ? fragment.verticalCenter + skew
            : fragment.verticalCenter
    }

    /// The receipt-wide vertical offset of the amount column, as the
    /// median of each amount fragment's signed delta to its nearest
    /// other-column neighbour. Zero when either column is too sparse to
    /// trust a median.
    private static func columnSkew(of fragments: [RecognizedLine]) -> Double {
        let amountColumn = fragments.filter { $0.horizontalCenter >= amountColumnThreshold }
        let labelColumn = fragments.filter { $0.horizontalCenter < amountColumnThreshold }
        guard amountColumn.count >= minimumSkewSamples, !labelColumn.isEmpty else {
            return 0
        }
        var deltas: [Double] = []
        for amount in amountColumn {
            let nearest = labelColumn.min {
                abs($0.verticalCenter - amount.verticalCenter) < abs($1.verticalCenter - amount.verticalCenter)
            }
            if let nearest {
                deltas.append(nearest.verticalCenter - amount.verticalCenter)
            }
        }
        deltas.sort()
        let middle = deltas.count / 2
        return deltas.count.isMultiple(of: 2)
            ? (deltas[middle - 1] + deltas[middle]) / 2
            : deltas[middle]
    }

    private static func mergeRow(_ row: [RecognizedLine]) -> RecognizedLine? {
        guard let first = row.first else { return nil }
        if row.count == 1 {
            return first
        }
        let leftToRight = row.sorted { $0.horizontalCenter < $1.horizontalCenter }
        return RecognizedLine(
            text: leftToRight.map(\.text).joined(separator: " "),
            verticalCenter: row.map(\.verticalCenter).reduce(0, +) / Double(row.count),
            // The tallest fragment carries the row's font-size signal for
            // the vendor heuristic.
            height: row.map(\.height).max() ?? first.height,
            horizontalCenter: row.map(\.horizontalCenter).reduce(0, +) / Double(row.count)
        )
    }
}
