import SwiftUI

/// One receipt, read-only this wave: the image (fetched via its presigned
/// URL) and every field, in the spec §7.2 order. Editing arrives with the
/// confirm screen in wave 4.
struct ReceiptDetailView: View {
    @StateObject private var model: ReceiptDetailModel
    private let receipt: Receipt

    init(api: APIClient, receipt: Receipt) {
        _model = StateObject(wrappedValue: ReceiptDetailModel(api: api))
        self.receipt = receipt
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
        .navigationTitle(receipt.vendor ?? ReceiptFormat.purchaseDate(receipt.purchasedAt))
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await model.load(id: receipt.id)
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
                    Text(ReceiptFormat.money(
                        cents: detail.receipt.totalCents,
                        currency: detail.receipt.currency
                    ))
                    .font(.largeTitle.bold())
                    .monospacedDigit()
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
            }

            Section("Details") {
                FieldRow(label: "Date", value: ReceiptFormat.purchaseDate(detail.receipt.purchasedAt))
                FieldRow(label: "Vendor", value: detail.receipt.vendor)
                FieldRow(label: "HST", value: money(detail.receipt.hstCents, detail.receipt.currency))
                FieldRow(label: "Subtotal", value: money(detail.receipt.subtotalCents, detail.receipt.currency))
                FieldRow(label: "Other tax", value: money(detail.receipt.otherTaxCents, detail.receipt.currency))
                FieldRow(label: "Tax number", value: detail.receipt.vendorTaxNumber)
                FieldRow(label: "Type", value: detail.receipt.isBusiness ? "Business" : "Personal")
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
                AsyncImage(url: image.downloadUrl) { phase in
                    switch phase {
                    case .empty:
                        CenteredProgressRow()
                            .frame(minHeight: 180)
                    case .success(let loaded):
                        loaded
                            .resizable()
                            .scaledToFit()
                    case .failure:
                        Label(
                            "The image could not be loaded.",
                            systemImage: "photo.badge.exclamationmark"
                        )
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    @unknown default:
                        EmptyView()
                    }
                }
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
