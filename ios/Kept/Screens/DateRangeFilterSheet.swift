import SwiftUI

/// The Home list's receipt-date range (`from`/`to`, inclusive bounds on
/// `purchased_at`). A sheet rather than another menu section because a
/// DatePicker cannot live inside a `Menu` - a menu takes buttons and
/// pickers, not controls.
///
/// Each side is independently optional and independently clearable:
/// "everything since April" and "everything up to year end" are both real
/// questions, and neither should force a bound nobody meant.
///
/// The two pickers edit a draft, and only Apply reaches the model. Live
/// binding would fire a list request per spin of a date wheel; one apply
/// is also what makes the paging restart happen once rather than a dozen
/// times.
struct DateRangeFilterSheet: View {
    let initialFrom: String?
    let initialTo: String?
    /// Called with the range to apply; nil on a side means "no bound".
    let apply: (_ from: String?, _ to: String?) async -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var fromDate: Date?
    @State private var toDate: Date?

    init(
        initialFrom: String?,
        initialTo: String?,
        apply: @escaping (_ from: String?, _ to: String?) async -> Void
    ) {
        self.initialFrom = initialFrom
        self.initialTo = initialTo
        self.apply = apply
        // An unparseable stored bound would be a client bug, not user
        // input; it degrades to "no bound", which the sheet then shows
        // honestly rather than pretending to hold a date it cannot read.
        _fromDate = State(initialValue: initialFrom.flatMap(ReceiptFormat.pickerDate(fromIso:)))
        _toDate = State(initialValue: initialTo.flatMap(ReceiptFormat.pickerDate(fromIso:)))
    }

    var body: some View {
        NavigationStack {
            Form {
                boundSection(
                    title: "Earliest",
                    setLabel: "Set an earliest date",
                    pickerLabel: "From",
                    date: $fromDate
                )
                boundSection(
                    title: "Latest",
                    setLabel: "Set a latest date",
                    pickerLabel: "Until",
                    date: $toDate
                )

                if isImpossible {
                    Section {
                        // The server answers this range honestly with
                        // nothing, which on the list is indistinguishable
                        // from "no receipts that month". Amber and stated,
                        // and it does not block Apply: the range is not
                        // wrong, it is just empty, and the person may be
                        // mid-way through setting the other end.
                        Label(
                            "The earliest date is after the latest one, so nothing can match.",
                            systemImage: "exclamationmark.triangle"
                        )
                        .font(.footnote)
                        .foregroundStyle(.orange)
                    }
                }
            }
            .navigationTitle("Receipt date")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Apply") {
                        let from = fromDate.map(ReceiptFormat.isoDate(fromPicker:))
                        let to = toDate.map(ReceiptFormat.isoDate(fromPicker:))
                        dismiss()
                        Task { await apply(from, to) }
                    }
                    .fontWeight(.semibold)
                }
            }
        }
    }

    private var isImpossible: Bool {
        guard let fromDate, let toDate else { return false }
        return fromDate > toDate
    }

    /// One bound: a picker and a way to remove it, or a way to add one.
    /// Both sides are the same shape, so neither can grow a behaviour the
    /// other lacks.
    @ViewBuilder
    private func boundSection(
        title: String,
        setLabel: String,
        pickerLabel: String,
        date: Binding<Date?>
    ) -> some View {
        Section(title) {
            if let value = date.wrappedValue {
                DatePicker(
                    pickerLabel,
                    selection: Binding(
                        get: { value },
                        set: { date.wrappedValue = $0 }
                    ),
                    displayedComponents: .date
                )
                .receiptDatePickerPin()
                Button("Remove this bound", role: .destructive) {
                    date.wrappedValue = nil
                }
            } else {
                Button(setLabel) {
                    // Today, in the same UTC frame the bound is stored in -
                    // a starting point to spin from, not a guess at what
                    // the person wants.
                    date.wrappedValue = ReceiptFormat.pickerDate(
                        fromIso: ReceiptFormat.isoDate(fromPicker: Date())
                    ) ?? Date()
                }
            }
        }
    }
}
