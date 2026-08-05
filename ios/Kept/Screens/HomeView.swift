import SwiftUI

/// Home, per spec §7.1: capture up top (a placeholder until wave 4 brings
/// the scanner), then the receipt list, newest purchase first, paged as it
/// scrolls. Pending receipts carry an amber badge and are counted in the
/// header - visible and slightly annoying, per spec §5.2a.
struct HomeView: View {
    @EnvironmentObject private var session: SessionController
    @StateObject private var model: ReceiptListModel
    @State private var showServerSettings = false

    /// Kept only to hand onward to the detail screen.
    private let api: APIClient

    init(api: APIClient) {
        _model = StateObject(wrappedValue: ReceiptListModel(api: api))
        self.api = api
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    capturePlaceholder
                }

                Section {
                    listContent
                } header: {
                    listHeader
                }
            }
            .navigationTitle("Kept")
            .toolbar {
                Menu {
                    Button("Server settings") {
                        showServerSettings = true
                    }
                    Button("Sign out", role: .destructive) {
                        session.signOut()
                    }
                } label: {
                    Label("More", systemImage: "ellipsis.circle")
                }
            }
            .navigationDestination(for: Receipt.self) { receipt in
                ReceiptDetailView(api: api, receipt: receipt)
            }
            .task {
                await model.loadFirstPage()
            }
            .refreshable {
                await model.loadFirstPage()
            }
            .sheet(isPresented: $showServerSettings) {
                ServerSettingsView()
            }
        }
    }

    // MARK: - Capture placeholder

    private var capturePlaceholder: some View {
        VStack(spacing: 8) {
            Button {
                // Wave 4: opens the document scanner.
            } label: {
                Label("Capture", systemImage: "doc.viewfinder")
                    .font(.title3.weight(.semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
            }
            .buttonStyle(.borderedProminent)
            .disabled(true)

            Text("Scanning arrives in a later build.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
        }
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
    }

    // MARK: - List

    private var listHeader: some View {
        HStack {
            Text("Receipts")
            Spacer()
            switch model.pendingCount {
            case .exact(0):
                EmptyView()
            case .exact(let count):
                PendingBadge(text: "\(count) pending")
            case .atLeast(let count):
                PendingBadge(text: "\(count)+ pending")
            case .unknown:
                // The count could not be fetched; saying so beats quietly
                // implying zero.
                PendingBadge(text: "Pending count unavailable")
            }
        }
    }

    @ViewBuilder
    private var listContent: some View {
        switch model.phase {
        case .loading:
            CenteredProgressRow(label: "Loading receipts")

        case .empty:
            ContentUnavailableView(
                "No receipts yet",
                systemImage: "doc.text",
                description: Text("Receipts appear here once they are captured.")
            )
            .listRowSeparator(.hidden)

        case .failed(let message):
            LoadFailureView(message: message) {
                await model.loadFirstPage()
            }

        case .loaded:
            ForEach(model.receipts) { receipt in
                NavigationLink(value: receipt) {
                    ReceiptRow(receipt: receipt)
                }
                .onAppear {
                    Task { await model.loadMoreIfNeeded(after: receipt) }
                }
            }
            nextPageFooter
        }
    }

    @ViewBuilder
    private var nextPageFooter: some View {
        switch model.nextPage {
        case .idle:
            EmptyView()
        case .loading:
            CenteredProgressRow()
        case .failed(let message):
            LoadFailureView(message: "Couldn't load more: \(message)") {
                await model.retryLoadMore()
            }
        }
    }
}

// MARK: - Rows

/// One receipt in the list: vendor and date on the left, amount on the
/// right, an amber badge when no human has confirmed the numbers yet.
struct ReceiptRow: View {
    let receipt: Receipt

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                if let vendor = receipt.vendor {
                    Text(vendor)
                } else {
                    // A stated absence, not a blank (spec §10A.1): the
                    // vendor was illegible or never captured.
                    Text("No vendor")
                        .italic()
                        .foregroundStyle(.secondary)
                }
                Text(ReceiptFormat.purchaseDate(receipt.purchasedAt))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            VStack(alignment: .trailing, spacing: 4) {
                Text(ReceiptFormat.money(cents: receipt.totalCents, currency: receipt.currency))
                    .monospacedDigit()
                if receipt.status == .pending {
                    PendingBadge(text: "Pending")
                }
            }
        }
    }
}

/// The amber marker for unconfirmed state, shared by rows and the header
/// count. Amber, not red: pending is unfinished, not wrong (§10A.1 applies
/// the same reasoning to the confirm screen's arithmetic warning).
struct PendingBadge: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.caption2.weight(.medium))
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(.orange.opacity(0.18), in: Capsule())
            .foregroundStyle(.orange)
    }
}
