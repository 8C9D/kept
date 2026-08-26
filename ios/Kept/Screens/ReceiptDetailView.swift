import SwiftUI

/// One receipt: the image (fetched via its presigned URL) and every field,
/// in the spec §7.2 order. The fields here are read-only by design - both
/// ways into editing, "Confirm this receipt" on a pending row and "Edit
/// receipt" on a confirmed one, present the same confirm form (§7.2), so
/// this screen has no editable field of its own and inherits the form's
/// behaviour whole.
struct ReceiptDetailView: View {
    @StateObject private var model: ReceiptDetailModel
    @ObservedObject private var options: ReceiptOptionsStore
    private let receipt: Receipt
    private let api: APIClient

    /// Non-nil while the confirm form is presented over this screen; the
    /// model is created at tap time from the already-loaded detail.
    @State private var confirmModel: ConfirmReceiptModel?

    init(api: APIClient, options: ReceiptOptionsStore, receipt: Receipt) {
        _model = StateObject(wrappedValue: ReceiptDetailModel(api: api))
        self.options = options
        self.receipt = receipt
        self.api = api
    }

    var body: some View {
        Group {
            switch model.phase {
            case .loading:
                ProgressView("Loading receipt")
            case .failed(let message):
                LoadFailureView(message: message) {
                    await model.load(id: receipt.id)
                }
                .padding()
            case .loaded(let detail):
                loadedBody(detail)
            }
        }
        .navigationTitle(receipt.displayVendor ?? ReceiptFormat.purchaseDate(receipt.displayPurchasedAt))
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await model.load(id: receipt.id)
        }
        .fullScreenCover(item: $confirmModel) { presented in
            NavigationStack {
                ConfirmReceiptView(
                    model: presented,
                    options: options,
                    onSaved: {
                        confirmModel = nil
                        // The row just changed; re-read it so the screen
                        // shows the saved truth, not a stale badge or a
                        // pre-edit value.
                        await model.load(id: receipt.id)
                        // An edit can introduce a category or payment
                        // method this account has never used; the pickers
                        // must know about it next time.
                        await options.refresh()
                    },
                    onSetAside: { confirmModel = nil }
                )
            }
        }
    }

    private func loadedBody(_ detail: ReceiptDetail) -> some View {
        List {
            Section {
                imageContent(detail.images)
            }

            // The total gets the card treatment §10A.1 specifies for the
            // confirm screen: largest type on screen, first place the eye
            // lands.
            Section {
                VStack(alignment: .leading, spacing: 4) {
                    if let totalCents = detail.receipt.displayTotalCents {
                        Text(ReceiptFormat.money(
                            cents: totalCents,
                            currency: detail.receipt.currency
                        ))
                        .font(.largeTitle.bold())
                        .monospacedDigit()
                    } else {
                        // Only a pending scan can lack a total; stated, in
                        // the same large type the number would occupy.
                        Text("No total yet")
                            .font(.largeTitle.bold())
                            .foregroundStyle(.secondary)
                    }
                    HStack(spacing: 8) {
                        Text("Total")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        if detail.receipt.status == .pending {
                            PendingBadge(text: "Pending confirmation")
                        }
                    }
                }
                .padding(.vertical, 4)

                switch detail.receipt.status {
                case .pending:
                    // A pending receipt's obvious next step, offered where
                    // the person already is - the header-badge queue must
                    // not be the only route (wave-4 re-test, the owner's
                    // finding: tapping a pending receipt was a dead end).
                    Button {
                        confirmModel = ConfirmReceiptModel(api: api, detail: detail)
                    } label: {
                        Text("Confirm this receipt")
                            .font(.headline)
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                case .confirmed:
                    // A confirmed receipt is still correctable - a typo in
                    // a total or a category is found weeks later, and
                    // re-scanning the paper is not the remedy (2026-08-26
                    // ruling). The same form, opened with nothing amber:
                    // these values are the person's own.
                    Button {
                        confirmModel = ConfirmReceiptModel(api: api, detail: detail, purpose: .edit)
                    } label: {
                        Text("Edit receipt")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                }
            }

            Section("Details") {
                // Merge-covered fields read the display rule (ReceiptDisplay):
                // pending shows the served merge, confirmed the record. The
                // rows below carry no suggestion and always show the row.
                FieldRow(label: "Date", value: ReceiptFormat.purchaseDate(detail.receipt.displayPurchasedAt))
                FieldRow(label: "Vendor", value: detail.receipt.displayVendor)
                FieldRow(label: "HST", value: money(detail.receipt.displayHstCents, detail.receipt.currency))
                FieldRow(label: "Subtotal", value: money(detail.receipt.displaySubtotalCents, detail.receipt.currency))
                FieldRow(label: "Category", value: detail.receipt.category)
                FieldRow(label: "Payment", value: detail.receipt.paymentMethod)
                FieldRow(label: "Notes", value: detail.receipt.notes)
            }
        }
    }

    @ViewBuilder
    private func imageContent(_ images: [ReceiptImage]) -> some View {
        if images.isEmpty {
            // Real for early data: receipts created before storage was
            // configured have no image rows. A stated absence, not a blank.
            Text("No image stored for this receipt.")
                .font(.footnote)
                .italic()
                .foregroundStyle(.secondary)
        } else {
            ForEach(images, id: \.page) { image in
                // The same component the confirm screen renders, so the
                // two screens' image behaviour cannot drift (wave-4
                // reviewer pass: this block was its copy).
                ReceiptImageView(source: .remote(image.downloadUrl))
            }
        }
    }

    /// Optional money for the detail rows: nil stays nil so FieldRow can
    /// state the absence.
    private func money(_ cents: Int?, _ currency: String) -> String? {
        guard let cents else { return nil }
        return ReceiptFormat.money(cents: cents, currency: currency)
    }
}

/// A labelled read-only field where a missing value says so - "Not
/// recorded", not an empty gap that reads as a rendering bug (§10A.1's
/// stated-absence rule, applied one wave early).
struct FieldRow: View {
    let label: String
    let value: String?

    var body: some View {
        LabeledContent(label) {
            if let value {
                Text(value)
                    .multilineTextAlignment(.trailing)
            } else {
                Text("Not recorded")
                    .italic()
                    .foregroundStyle(.secondary)
            }
        }
    }
}
