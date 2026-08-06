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
/// The rule: fragments whose vertical centers sit within half the taller
/// fragment's height of a row's running center belong to that row; a row's
/// text is its fragments joined left to right. Validated against one real
/// thermal receipt so far (spec §7.3 note) - the accuracy table is what
/// re-checks it.
enum ReceiptRowAssembler {
    static func assembleRows(_ fragments: [RecognizedLine]) -> [RecognizedLine] {
        let ordered = fragments.sorted { $0.verticalCenter < $1.verticalCenter }

        var rows: [[RecognizedLine]] = []
        for fragment in ordered {
            if var currentRow = rows.last, let center = rowCenter(currentRow) {
                let tallest = currentRow.map(\.height).max() ?? 0
                let tolerance = 0.5 * max(fragment.height, tallest)
                if abs(fragment.verticalCenter - center) <= tolerance {
                    currentRow.append(fragment)
                    rows[rows.count - 1] = currentRow
                    continue
                }
            }
            rows.append([fragment])
        }

        return rows.compactMap(mergeRow)
    }

    private static func rowCenter(_ row: [RecognizedLine]) -> Double? {
        guard !row.isEmpty else { return nil }
        return row.map(\.verticalCenter).reduce(0, +) / Double(row.count)
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
