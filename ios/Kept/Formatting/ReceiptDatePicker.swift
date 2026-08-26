import SwiftUI

extension View {
    /// The calendar and timezone pin every DatePicker editing a receipt
    /// date must carry, so the picker, the parser and the formatter agree
    /// on which day an instant belongs to.
    ///
    /// ⚠ Not decoration. `purchasedAt` is a zoneless calendar date, and
    /// `ReceiptFormat` parses and renders it in UTC; an unpinned picker
    /// shows March 20 as March 19 anywhere west of Greenwich and saves the
    /// 21st when the person "corrects" it (wave-4 reviewer pass, that
    /// wave's highest finding).
    ///
    /// It is one modifier rather than two lines repeated because there are
    /// now two such pickers - the confirm form's date and the list's date
    /// range - and a pin that holds on one screen and not the other would
    /// be the same defect, found twice.
    func receiptDatePickerPin() -> some View {
        environment(\.calendar, ReceiptFormat.utcCalendar)
            .environment(\.timeZone, ReceiptFormat.utcTimeZone)
    }
}
