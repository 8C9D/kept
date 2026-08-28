import SwiftUI

/// Home, per spec §7.1: capture up top, then the receipt list, newest
/// purchase first, paged as it scrolls. Pending receipts carry an amber
/// badge and are counted in the header - visible and slightly annoying,
/// per spec §5.2a.
///
/// Search, sort and the filters - status, category, payment method and
/// receipt-date range (2026-08-26) - are all server-side and travel
/// through the same keyset paging: the screen never re-orders or
/// re-filters rows it already has, because that would disagree with the
/// next page.
///
/// A running-totals block sits below the outbox (proposal #3, 2026-08-28):
/// confirmed-only count, total spent, total HST for the current filter,
/// re-fetched whenever the filter changes - see `summarySection`'s own
/// comment for how it reconciles with the pending badge in `listHeader`
/// below, which is a different, whole-account number by design.
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
    /// Pushes the export screen (2026-08-28 - see Export/ExportView.swift
    /// for why this exists at all).
    @State private var showExport = false
    /// Whether the receipt-date range sheet is up. A sheet because a
    /// DatePicker cannot live inside the toolbar Menu that opens it.
    @State private var showDateRangeFilter = false
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
    private let eventLogger: EventLogger

    init(api: APIClient, options: ReceiptOptionsStore, eventLogger: EventLogger) {
        _model = StateObject(wrappedValue: ReceiptListModel(api: api, eventLogger: eventLogger))
        self.api = api
        self.eventLogger = eventLogger
        self.options = options
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    captureButton
                }

                outboxSection

                summarySection

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
                        // Least destructive first, same rule the two
                        // buttons below already follow: this one changes
                        // nothing, so it sits above Sign out and Delete
                        // account rather than among them.
                        Button {
                            showExport = true
                        } label: {
                            Label("Export", systemImage: "square.and.arrow.up")
                        }
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
                ReceiptDetailView(api: api, options: options, eventLogger: eventLogger, receipt: receipt) {
                    // Follows the same refresh path every other mutation
                    // that can change the list already does (below, and
                    // the confirm queue's own completion) - a full first-
                    // page reload rather than surgically removing one row,
                    // so a deleted receipt cannot linger as a stale row.
                    await model.loadFirstPage()
                }
            }
            .navigationDestination(isPresented: $showExport) {
                ExportView(api: api, eventLogger: eventLogger)
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
            // Anchored to the List rather than to the menu button, for the
            // reason the dialogs below are: the toolbar Menu that raises
            // this closes on tap, and a presentation modifier attached to
            // a control that has gone away is fragile ground.
            .sheet(isPresented: $showDateRangeFilter) {
                DateRangeFilterSheet(
                    initialFrom: model.query.from,
                    initialTo: model.query.to
                ) { from, to in
                    await model.setDateRange(from: from, to: to)
                }
            }
            #if DEBUG
            .sheet(isPresented: $showServerSettings) {
                ServerSettingsView()
            }
            #endif
            .fullScreenCover(isPresented: $showCaptureFlow) {
                CaptureFlowView(outbox: outbox, options: options, eventLogger: eventLogger) { didChangeAnything in
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
                ConfirmQueueCover(api: api, options: options, eventLogger: eventLogger) {
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

            reusableValueFilter(
                name: "Category",
                anyLabel: "Any category",
                unavailableLabel: "Categories unavailable",
                icon: "tag",
                values: options.options.categories,
                selection: binding(\.category, apply: model.setCategory)
            )

            reusableValueFilter(
                name: "Payment",
                anyLabel: "Any payment method",
                unavailableLabel: "Payment methods unavailable",
                icon: "creditcard",
                values: options.options.paymentMethods,
                selection: binding(\.paymentMethod, apply: model.setPaymentMethod)
            )

            Button {
                showDateRangeFilter = true
            } label: {
                // The applied range on the control that opens it, so a
                // narrowed list says so without opening anything.
                Label(model.query.dateRangeLabel(), systemImage: "calendar")
            }

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

    /// The two free-text filters, which are the same control over
    /// different values: the person's own past categories and payment
    /// methods (GET /api/receipts/options).
    ///
    /// With no values there is nothing to pick from - which is either "no
    /// such value has ever been used" or a failed fetch, and those are
    /// different facts, so the failed one says so instead of looking like
    /// the empty one. One function rather than two near-identical ones, so
    /// the pair cannot drift.
    @ViewBuilder
    private func reusableValueFilter(
        name: String,
        anyLabel: String,
        unavailableLabel: String,
        icon: String,
        values: [String],
        selection: Binding<String?>
    ) -> some View {
        if !values.isEmpty {
            Menu {
                Picker(name, selection: selection) {
                    Text(anyLabel).tag(String?.none)
                    // Distinct, as the options route serves them.
                    ForEach(values, id: \.self) { value in
                        Text(value).tag(String?.some(value))
                    }
                }
                .pickerStyle(.inline)
            } label: {
                Label(selection.wrappedValue ?? name, systemImage: icon)
            }
        } else if options.lastFailure != nil {
            Label(unavailableLabel, systemImage: "exclamationmark.triangle")
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

    // MARK: - Running totals (proposal #3, 2026-08-28)

    /// GET /api/receipts/summary's confirmed-only totals for whatever
    /// filter `model.query` currently applies - count, total spent, total
    /// HST - with its own pending count stated separately, never folded
    /// into the money (the proposal's own named risk: "the number invites
    /// being read as a tax figure... a summary that quietly counted
    /// pending rows would disagree with the export"). Absent for three
    /// reasons that all render identically - nothing has loaded yet, the
    /// page itself failed, or the summary fetch alone failed - because
    /// this is pure enhancement over the list and never something a
    /// failure here should announce (ReceiptListModel.summary's own
    /// comment).
    ///
    /// **Reconciling this with `listHeader`'s pending badge below.** Two
    /// different questions, on purpose, not two numbers that happen to
    /// disagree: `model.pendingCount` (the header) is this ACCOUNT's total
    /// unconfirmed receipts, independent of any filter - the nag that
    /// opens the confirm queue, unchanged by 2026-08-28. `summary.pendingCount`
    /// here is pending rows WITHIN THE CURRENT FILTER - context for these
    /// particular totals, not a second nag. They read the same only when
    /// no filter is narrowing the list; the copy below says "in this view"
    /// precisely so the two never look like the same claim stated twice.
    @ViewBuilder
    private var summarySection: some View {
        if let summary = model.summary {
            Section {
                // GET /api/receipts/summary carries no currency of its own
                // (it sums across every matching row) - "CAD" the same way
                // ConfirmReceiptModel's capture-time init hardcodes it:
                // currency is not editable anywhere in this client (spec,
                // wave-4 report §6.3) and the server column default is CAD.
                SummaryRow(summary: summary, currency: "CAD")
            }
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

/// The running-totals block (proposal #3, 2026-08-28): count, total spent
/// and total HST for confirmed receipts in the CURRENT filter, with the
/// pending count in that same filter stated on its own line - never
/// blended into the money, per the proposal's own named risk ("the number
/// invites being read as a tax figure"). Plain text, not amber: this is a
/// read-only report, not a suggestion anyone confirms.
struct SummaryRow: View {
    let summary: ReceiptSummary
    let currency: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(ReceiptFormat.money(cents: summary.confirmed.totalCents, currency: currency))
                    .font(.title3.weight(.semibold))
                    .monospacedDigit()
                Text(receiptCountLabel)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Text("HST \(ReceiptFormat.money(cents: summary.confirmed.hstCents, currency: currency))")
                .font(.footnote)
                .foregroundStyle(.secondary)
            // Stated every time a summary shows, zero included: this is
            // what keeps "confirmed only" a fact about the number above
            // rather than a caveat that only appears when it is bad news.
            Text(pendingCaveat)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }

    private var receiptCountLabel: String {
        "· \(summary.confirmed.count) confirmed \(summary.confirmed.count == 1 ? "receipt" : "receipts") in this view"
    }

    private var pendingCaveat: String {
        summary.pendingCount == 0
            ? "No pending receipts in this view."
            : "Excludes \(summary.pendingCount) pending \(summary.pendingCount == 1 ? "receipt" : "receipts") in this view, not yet confirmed."
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
