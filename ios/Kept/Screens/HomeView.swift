import SwiftUI

/// Home, per spec §7.1: capture up top, then the receipt list, newest
/// purchase first, paged as it scrolls. Pending receipts carry an amber
/// badge and are counted in the header - visible and slightly annoying,
/// per spec §5.2a.
///
/// Search, sort and the two filters (2026-08-26) are all server-side and
/// travel through the same keyset paging: the screen never re-orders or
/// re-filters rows it already has, because that would disagree with the
/// next page.
struct HomeView: View {
    @EnvironmentObject private var session: SessionController
    @EnvironmentObject private var outbox: OutboxController
    @StateObject private var model: ReceiptListModel
    @ObservedObject private var options: ReceiptOptionsStore
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
    /// Whether the account-deletion confirmation is up. Deliberately not
    /// derived from any session state: the dialog is a question, and the
    /// answer is what starts anything.
    @State private var confirmingAccountDeletion = false

    /// Kept only to hand onward to the capture, confirm, and detail flows.
    private let api: APIClient

    init(api: APIClient, options: ReceiptOptionsStore) {
        _model = StateObject(wrappedValue: ReceiptListModel(api: api))
        self.api = api
        self.options = options
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
            .searchable(
                text: $model.searchText,
                placement: .navigationBarDrawer(displayMode: .always),
                prompt: "Vendor, category, or notes"
            )
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    sortAndFilterMenu
                }
                ToolbarItem(placement: .topBarTrailing) {
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
                        // App Store Guideline 5.1.1(v): an app that creates
                        // accounts must let a person delete theirs from inside
                        // it. It sits beside Sign out because that is where
                        // someone looks for "I am done with this app", and it is
                        // last so the tap above it is the harmless one.
                        Button("Delete account", role: .destructive) {
                            confirmingAccountDeletion = true
                        }
                        .disabled(session.accountDeletion == .inProgress)
                    } label: {
                        Label("More", systemImage: "ellipsis.circle")
                    }
                }
            }
            .navigationDestination(for: Receipt.self) { receipt in
                ReceiptDetailView(api: api, options: options, receipt: receipt)
            }
            .task {
                await model.loadFirstPage()
            }
            // Beside the list, never in front of it: the filter menu's
            // category list fills in when this lands, and every screen
            // works without it.
            .task {
                await options.refresh()
            }
            // The search debounce. `.task(id:)` cancels and restarts on
            // every keystroke, so only the last one outlives the sleep -
            // typing "coffee" costs one request, not six. The run at
            // appearance reaches applySearch with an unchanged term,
            // which the model treats as a no-op.
            .task(id: model.searchText) {
                do {
                    try await Task.sleep(for: .milliseconds(350))
                } catch {
                    return
                }
                await model.applySearch()
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
                CaptureFlowView(outbox: outbox, options: options) { didChangeAnything in
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
                ConfirmQueueCover(api: api, options: options) {
                    showConfirmQueue = false
                    Task {
                        await model.loadFirstPage()
                        // A confirm sitting is where new categories and
                        // payment methods get typed; pick them up.
                        await options.refresh()
                    }
                }
            }
            // Anchored to the List for the same reason the discard dialog
            // above is: the toolbar Menu that raises it closes on tap, and a
            // presentation modifier attached to a control that has gone away
            // is fragile ground.
            .confirmationDialog(
                "Delete your account?",
                isPresented: $confirmingAccountDeletion,
                titleVisibility: .visible
            ) {
                Button("Delete account and all receipts", role: .destructive) {
                    Task { await session.deleteAccount() }
                }
                Button("Keep my account", role: .cancel) {}
            } message: {
                // Says what goes, and names the way to keep a copy first.
                // These are tax records: a dialog that only said "this
                // cannot be undone" would be true and still not enough.
                Text("This permanently deletes your Kept account and every receipt in it, including the images. It cannot be undone. If you need the records, run an export from the web app first.")
            }
            .alert(
                "Your account was not deleted",
                isPresented: Binding(
                    get: { session.accountDeletion.failureMessage != nil },
                    set: { if !$0 { session.clearAccountDeletionFailure() } }
                )
            ) {
                Button("OK", role: .cancel) {
                    session.clearAccountDeletionFailure()
                }
            } message: {
                // The reason in the server's or the transport's own words,
                // plus the fact that matters most: nothing was destroyed.
                Text(session.accountDeletion.failureMessage ?? "")
            }
            .overlay {
                if session.accountDeletion == .inProgress {
                    // A deletion runs an Apple sheet and then a request; the
                    // list underneath must not look tappable in between.
                    ZStack {
                        Color.black.opacity(0.25).ignoresSafeArea()
                        CenteredProgressRow(label: "Deleting your account")
                            .padding()
                            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                    }
                }
            }
        }
    }

    // MARK: - Sort and filter (server-driven; §7.1)

    /// One toolbar menu for the ordering and the two filters. The icon
    /// fills in while anything is narrowing the list, so rows missing on
    /// purpose never read as rows lost.
    private var sortAndFilterMenu: some View {
        Menu {
            Picker("Sort by", selection: binding(\.sort, apply: model.setSort)) {
                ForEach(ReceiptQuery.Sort.allCases) { sort in
                    Text(sort.label).tag(sort)
                }
            }
            .pickerStyle(.inline)

            Picker("Order", selection: binding(\.order, apply: model.setOrder)) {
                // Said in the sort key's own terms: "Newest first" on a
                // date, "Largest first" on an amount.
                Text(model.query.sort.orderLabel(.desc)).tag(ReceiptQuery.Order.desc)
                Text(model.query.sort.orderLabel(.asc)).tag(ReceiptQuery.Order.asc)
            }
            .pickerStyle(.inline)

            Picker("Show", selection: binding(\.status, apply: model.setStatus)) {
                Text("All receipts").tag(ReceiptStatus?.none)
                Text("Pending only").tag(ReceiptStatus?.some(.pending))
                Text("Confirmed only").tag(ReceiptStatus?.some(.confirmed))
            }
            .pickerStyle(.inline)

            categoryFilter

            if model.query.isFiltering {
                Divider()
                Button("Clear filters") {
                    Task { await model.clearFilters() }
                }
            }
        } label: {
            Label(
                "Sort and filter",
                systemImage: model.query.isFiltering
                    ? "line.3.horizontal.decrease.circle.fill"
                    : "line.3.horizontal.decrease.circle"
            )
        }
    }

    /// The category filter's values are the person's own past categories
    /// (GET /api/receipts/options). With none fetched there is nothing to
    /// pick from - which is either "no category has ever been used" or a
    /// failed fetch, and those are different facts, so the failed one says
    /// so instead of looking like the empty one.
    @ViewBuilder
    private var categoryFilter: some View {
        if !options.options.categories.isEmpty {
            Menu {
                Picker("Category", selection: binding(\.category, apply: model.setCategory)) {
                    Text("Any category").tag(String?.none)
                    ForEach(options.options.categories, id: \.self) { category in
                        Text(category).tag(String?.some(category))
                    }
                }
                .pickerStyle(.inline)
            } label: {
                Label(model.query.category ?? "Category", systemImage: "tag")
            }
        } else if options.lastFailure != nil {
            Label("Categories unavailable", systemImage: "exclamationmark.triangle")
        }
    }

    /// A read of the current query paired with the model call that changes
    /// it - one shape for all four controls, so none of them can quietly
    /// skip the restart-from-page-one the model does on every change.
    private func binding<Value>(
        _ path: KeyPath<ReceiptQuery, Value>,
        apply: @escaping (Value) async -> Void
    ) -> Binding<Value> {
        Binding(
            get: { model.query[keyPath: path] },
            set: { newValue in Task { await apply(newValue) } }
        )
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
            // Two different facts: an account with nothing in it, and a
            // filter set that happens to match nothing. Saying "no
            // receipts yet" over an active search would be a lie.
            if model.query.isFiltering {
                ContentUnavailableView(
                    "No matching receipts",
                    systemImage: "line.3.horizontal.decrease.circle",
                    description: Text("Nothing here matches the current search and filters.")
                )
                .listRowSeparator(.hidden)
            } else {
                ContentUnavailableView(
                    "No receipts yet",
                    systemImage: "doc.text",
                    description: Text("Receipts appear here once they are captured.")
                )
                .listRowSeparator(.hidden)
            }

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
