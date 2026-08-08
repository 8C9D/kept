import SwiftUI

/// Home, per spec §7.1: capture up top (a placeholder until wave 4 brings
/// the scanner), then the receipt list, newest purchase first, paged as it
/// scrolls. Pending receipts carry an amber badge and are counted in the
/// header - visible and slightly annoying, per spec §5.2a.
struct HomeView: View {
    @EnvironmentObject private var session: SessionController
    @EnvironmentObject private var outbox: OutboxController
    @StateObject private var model: ReceiptListModel
    #if DEBUG
    @State private var showServerSettings = false
    #endif
    @State private var showCaptureFlow = false
    @State private var showConfirmQueue = false
    /// The needs-attention item a discard confirmation is showing for.
    @State private var discardCandidate: OutboxController.Entry?
    /// Coalesces list reloads while the outbox drains a batch: eighty
    /// receipts landing server-side must not mean eighty full list
    /// reloads under the user's thumb (reviewer finding).
    @State private var listReloadDebounce: Task<Void, Never>?

    /// Kept only to hand onward to the capture, confirm, and detail flows.
    private let api: APIClient

    init(api: APIClient) {
        _model = StateObject(wrappedValue: ReceiptListModel(api: api))
        self.api = api
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    captureButton
                }

                outboxSection

                Section {
                    listContent
                } header: {
                    listHeader
                }
            }
            .navigationTitle("Kept")
            .toolbar {
                Menu {
                    // Development only - see SignInView for the reasoning.
                    #if DEBUG
                    Button("Server settings") {
                        showServerSettings = true
                    }
                    #endif
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
            #if DEBUG
            .sheet(isPresented: $showServerSettings) {
                ServerSettingsView()
            }
            #endif
            .fullScreenCover(isPresented: $showCaptureFlow) {
                CaptureFlowView(outbox: outbox) { didChangeAnything in
                    showCaptureFlow = false
                    if didChangeAnything {
                        Task { await model.loadFirstPage() }
                    }
                }
            }
            // Each receipt the outbox lands server-side turns a queued row
            // here into a real pending receipt there; refresh - debounced,
            // so a draining batch coalesces into one reload at the end
            // instead of one per receipt - and the person watches the
            // queue drain into the list.
            .onChange(of: outbox.serverConfirmedCount) {
                listReloadDebounce?.cancel()
                listReloadDebounce = Task {
                    try? await Task.sleep(for: .milliseconds(600))
                    guard !Task.isCancelled else { return }
                    await model.loadFirstPage()
                }
            }
            // Anchored to the List, not the outbox Section: a Section can
            // disappear (the queue draining empty) while its dialog is up,
            // and presentation modifiers on lazily-built containers are
            // fragile ground (reviewer finding).
            .confirmationDialog(
                "Discard this receipt?",
                isPresented: Binding(
                    get: { discardCandidate != nil },
                    set: { if !$0 { discardCandidate = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button("Discard receipt", role: .destructive) {
                    if let candidate = discardCandidate {
                        Task { await outbox.discardBlockedItem(id: candidate.id) }
                    }
                    discardCandidate = nil
                }
                Button("Keep it", role: .cancel) {
                    discardCandidate = nil
                }
            } message: {
                Text("Its scanned image is deleted from this phone and it never reaches your receipts. This cannot be undone.")
            }
            .fullScreenCover(isPresented: $showConfirmQueue) {
                ConfirmQueueCover(api: api) {
                    showConfirmQueue = false
                    Task { await model.loadFirstPage() }
                }
            }
        }
    }

    // MARK: - Capture

    private var captureButton: some View {
        VStack(spacing: 8) {
            Button {
                showCaptureFlow = true
            } label: {
                // An explicit HStack, not Label: inside a List, Label
                // reserves a leading icon column and renders left-shifted
                // (wave-4 device run, the owner's finding 2 - the label was
                // visibly off-center).
                HStack(spacing: 6) {
                    Image(systemName: "doc.viewfinder")
                    Text("Capture")
                }
                .font(.title3.weight(.semibold))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
            }
            .buttonStyle(.borderedProminent)
            .disabled(!DocumentScannerView.isSupported)

            if !DocumentScannerView.isSupported {
                // The simulator, in practice. A stated reason beats a
                // mysteriously dead button.
                Text("Scanning needs a device with a camera.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
            }
        }
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
    }

    // MARK: - Outbox (spec §7.4: queued items surface here, with status)

    @ViewBuilder
    private var outboxSection: some View {
        let hasNotes = outbox.otherAccountCount > 0
            || outbox.unreadableCount > 0
            || outbox.loadFailureNote != nil
            || outbox.drainFailureNote != nil
        if !outbox.entries.isEmpty || hasNotes {
            Section {
                ForEach(outbox.entries) { entry in
                    OutboxEntryRow(
                        entry: entry,
                        onRetry: { retry(entry) },
                        onDiscard: { discardCandidate = entry }
                    )
                }
                outboxNotes
            } header: {
                Text("On this phone")
            }
        }
    }

    private func retry(_ entry: OutboxController.Entry) {
        if case .needsAttention = entry.status {
            Task { await outbox.retryBlockedItem(id: entry.id) }
        } else {
            outbox.externalTrigger()
        }
    }

    /// Conditions about the queue as a whole, stated rather than implied.
    @ViewBuilder
    private var outboxNotes: some View {
        if let note = outbox.loadFailureNote {
            Text(note)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        if let note = outbox.drainFailureNote {
            Text(note)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        if outbox.unreadableCount > 0 {
            Text("\(outbox.unreadableCount) saved \(outbox.unreadableCount == 1 ? "receipt" : "receipts") could not be read from this phone's storage.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        if outbox.otherAccountCount > 0 {
            Text("\(outbox.otherAccountCount) \(outbox.otherAccountCount == 1 ? "receipt" : "receipts") captured under another account will upload when that account signs in.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
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
                // Tapping the badge opens the confirm queue (spec §6A):
                // the nag and the way to make it stop are the same control.
                Button {
                    showConfirmQueue = true
                } label: {
                    PendingBadge(text: "\(count) pending - confirm")
                }
                .buttonStyle(.plain)
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
/// Fields read the display rule (ReceiptDisplay): a pending row shows the
/// served merge, a confirmed one its record.
struct ReceiptRow: View {
    let receipt: Receipt

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                if let vendor = receipt.displayVendor {
                    Text(vendor)
                } else {
                    // A stated absence, not a blank (spec §10A.1): the
                    // vendor was illegible or never captured.
                    Text("No vendor")
                        .italic()
                        .foregroundStyle(.secondary)
                }
                Text(ReceiptFormat.purchaseDate(receipt.displayPurchasedAt))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            VStack(alignment: .trailing, spacing: 4) {
                if let totalCents = receipt.displayTotalCents {
                    Text(ReceiptFormat.money(cents: totalCents, currency: receipt.currency))
                        .monospacedDigit()
                } else {
                    // A pending scan whose total the parser couldn't read:
                    // a stated absence until the confirm screen fills it.
                    Text("No total yet")
                        .font(.caption)
                        .italic()
                        .foregroundStyle(.secondary)
                }
                if receipt.status == .pending {
                    PendingBadge(text: "Pending")
                }
            }
        }
    }
}

/// One queued receipt waiting on this phone: when it was captured, where
/// it is in its journey, and - when it is stuck - the reason and the two
/// human actions (spec §7.4: status and a manual retry, never a silent
/// queue). Needs-attention rows get their reason in full; everything else
/// is a single calm line, because a healthy queue should read as "handled".
struct OutboxEntryRow: View {
    let entry: OutboxController.Entry
    let onRetry: () -> Void
    let onDiscard: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("Captured \(ReceiptFormat.captureMoment(entry.capturedAt))")
                Spacer()
                statusBadge
            }
            switch entry.status {
            case .waiting, .processing:
                EmptyView()
            case .waitingToRetry(let message):
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button("Retry now", action: onRetry)
                    .font(.caption.weight(.medium))
                    .buttonStyle(.borderless)
            case .needsAttention(let message):
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                HStack(spacing: 16) {
                    Button("Retry", action: onRetry)
                    Button("Discard", role: .destructive, action: onDiscard)
                }
                .font(.caption.weight(.medium))
                .buttonStyle(.borderless)
            }
        }
        .font(.subheadline)
    }

    @ViewBuilder
    private var statusBadge: some View {
        switch entry.status {
        case .waiting:
            Text("Waiting to upload")
                .font(.caption2)
                .foregroundStyle(.secondary)
        case .processing:
            HStack(spacing: 4) {
                ProgressView()
                    .controlSize(.small)
                Text("Uploading")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        case .waitingToRetry:
            Text("Will retry")
                .font(.caption2)
                .foregroundStyle(.orange)
        case .needsAttention:
            PendingBadge(text: "Needs attention")
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
