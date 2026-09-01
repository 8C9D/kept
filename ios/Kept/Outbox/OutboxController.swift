import CryptoKit
import Foundation

/// The saving side of capture (spec §7.4): CaptureFlowModel hands each
/// scanned page here and returns to Home without touching the network.
/// Split from OutboxController's full surface so its tests script a stub
/// instead of a real queue.
@MainActor
protocol OutboxEnqueuing: AnyObject {
    /// Durably queues one scanned page as a pending receipt-to-be; the
    /// drain runs OCR later. When this returns, the receipt is safe on
    /// the phone; when it throws (a full disk, mainly), the capture flow
    /// must say so - the paper is still in the person's hand, and a false
    /// "saved" is the one unforgivable answer (wave-5 kickoff §1).
    func enqueue(imageData: Data) async throws

    /// The already-read variant: text extraction already ran (its result
    /// rides in `parsed`, so the drain never re-reads the document), and
    /// when the person confirmed on the spot, `confirmation` carries their
    /// fields - the create lands the receipt already `confirmed`. A nil
    /// confirmation is the "Later" exit: queued pending, like a batch
    /// page - and `partial` is then whatever they had typed before
    /// leaving, so that exit stops costing them their typing (2026-09-01).
    /// Nil for both is the ordinary Later: the parser's snapshot alone.
    ///
    /// `document` rather than a bare `Data` since 2026-09-01: the bytes
    /// can now be an imported PDF instead of a photograph, and a receipt
    /// can carry more than one page. What the bytes are, which reader read
    /// them, and what else belongs to the same receipt travel together so
    /// no call site can set one and forget another.
    func enqueue(
        document: OutboxDocument,
        parsed: ParsedReceipt,
        confirmation: ConfirmedReceiptFields?,
        partial: PendingReceiptFields?
    ) async throws
}

extension OutboxEnqueuing {
    /// The pre-2026-09-01 shapes, kept so the call sites and tests holding
    /// one photographed page with nothing half-typed stay as short as they
    /// were.
    func enqueue(
        imageData: Data,
        parsed: ParsedReceipt,
        confirmation: ConfirmedReceiptFields?
    ) async throws {
        try await enqueue(imageData: imageData, parsed: parsed, confirmation: confirmation, partial: nil)
    }

    func enqueue(
        imageData: Data,
        parsed: ParsedReceipt,
        confirmation: ConfirmedReceiptFields?,
        partial: PendingReceiptFields?
    ) async throws {
        try await enqueue(
            document: .photo(imageData),
            parsed: parsed,
            confirmation: confirmation,
            partial: partial
        )
    }
}

/// The offline outbox (spec §7.4): owns the durable queue of captured
/// receipts and drains it to the server - OCR, presigned upload, create -
/// retrying with backoff, pausing for sign-in, and surfacing anything
/// stuck on Home. The person is never blocked on any of this and never
/// told something succeeded that has not: an outbox row means "on this
/// phone", a receipt in the list means the server confirmed it, and there
/// is no state in between.
///
/// Concurrency shape, learned the hard way over waves 3-4: all state
/// lives on the main actor, and the drain is single-flight by task
/// identity - requestDrain() while a drain runs is a no-op, so a
/// double-tapped retry cannot start a second pass over the same item. The
/// drain re-reads `items` and re-checks the signed-in user at every step
/// boundary, because every await is a suspension point where an enqueue,
/// a discard, or a whole account switch may have run (the reviewer found
/// the first draft checking ownership only at pass start, which left a
/// mid-flight sign-out able to upload one user's receipt under another's
/// session - constraint 4's worst case).
@MainActor
final class OutboxController: ObservableObject {
    /// One queued receipt as Home renders it.
    struct Entry: Equatable, Identifiable {
        let id: UUID
        let capturedAt: Date
        let status: Status

        enum Status: Equatable {
            /// In line; the drain will reach it.
            case waiting
            /// Being worked on right now (OCR, upload, or create).
            case processing
            /// A retryable failure (no signal, server down, an image OCR
            /// keeps choking on) paused this item; the message is the most
            /// recent reason.
            case waitingToRetry(message: String)
            /// A permanent failure stopped this item. It never auto-runs
            /// again: a human retries it or discards it (kickoff §3).
            case needsAttention(message: String)
        }
    }

    /// The signed-in user's queue, oldest capture first.
    @Published private(set) var entries: [Entry] = []
    /// Queued receipts captured under a different account than the one
    /// signed in. Held, stated, and never uploaded until their owner signs
    /// back in (constraint 4).
    @Published private(set) var otherAccountCount = 0
    /// Records on disk that could not be read back - a record that fails
    /// to decode, or an image whose commit record never got written
    /// because the process died mid-save. Counted and stated on Home,
    /// kept on disk, never silently dropped or deleted.
    @Published private(set) var unreadableCount = 0
    /// Bumps once per receipt the server confirmed (created, or 409 -
    /// already there). Home refreshes its list when this changes, which is
    /// how a queued row turns into a real pending receipt on screen.
    @Published private(set) var serverConfirmedCount = 0
    /// Non-nil when the queue itself could not be loaded from disk. The
    /// load is retried on every drain trigger, so the condition heals
    /// itself if the disk does.
    @Published private(set) var loadFailureNote: String?
    /// A queue-wide condition the drain hit that belongs to no single
    /// item: the keychain refusing to read (device locked mid-drain), or
    /// a finished receipt's local copy refusing to delete. Stated, never
    /// swallowed - a background failure nobody can see is the worst kind
    /// (wave-5 kickoff §5).
    @Published private(set) var drainFailureNote: String?

    /// After this many failed OCR attempts an image uploads with empty
    /// suggestions: the receipt's safety outranks its prefill, and the
    /// confirm screen already handles a suggestion-less receipt.
    static let maxOcrAttempts = 3

    private let store: OutboxStore
    private let api: any KeptAPI
    private let recognizer: any ReceiptTextRecognizer
    private let tokenStore: SessionTokenStore
    private let connectivity: ConnectivityMonitor
    private let backgroundContinuation: BackgroundContinuation
    private let now: @Sendable () -> Date

    /// The in-memory mirror of the store, sorted by sequence. Mutations
    /// write the store first, then this (the one exception, OCR attempt
    /// counting, is argued at its site), so the two cannot disagree for
    /// longer than one failed write - which is surfaced, not swallowed.
    private var items: [OutboxItem] = []
    /// Set once the first successful loadAll has run; enqueues and drains
    /// both ensure it, so a failed load at launch is retried rather than
    /// permanent (reviewer finding: start() loading exactly once made a
    /// transient disk error at launch hide the queue for the whole run).
    private var hasLoadedOnce = false
    /// The next FIFO position, claimed synchronously at enqueue - two
    /// interleaved enqueues can never share a sequence, which is what
    /// keeps "two receipts captured offline both arrive, in order" true.
    private var nextSequence = 1
    /// The item a drain pass is working on, for status display.
    private var activeItemId: UUID?
    /// Most recent retryable failure per item, in-memory only: a relaunch
    /// retries immediately anyway, so persisting the message would only
    /// preserve staleness.
    private var retryMessages: [UUID: String] = [:]

    /// Single-flight drain (see the type comment).
    private var drainTask: Task<Void, Never>?
    /// Whether a drain pass is running. Tests poll this to wait for the
    /// fire-and-forget drain to settle; nothing in the app reads it.
    var isDraining: Bool { drainTask != nil }
    /// The scheduled backoff retry, if one is waiting. Any external
    /// trigger - foreground, connectivity, a new capture, sign-in, a tap
    /// on Retry - cancels it and drains immediately with the delay reset.
    private var pendingRetry: Task<Void, Never>?
    private var retryDelay: TimeInterval = OutboxController.baseRetryDelay

    private static let baseRetryDelay: TimeInterval = 2
    private static let maxRetryDelay: TimeInterval = 300

    /// The person's own past vendor names, for the vendor heuristic's
    /// known-vendor pass (2026-09-01, `ReceiptParser.parse`). Read from
    /// whatever `ReceiptOptionsStore` last cached - never fetched: the
    /// drain must work with no network, which is the whole point of it.
    /// Defaulted to the on-disk cache so every existing construction site
    /// (and every test) keeps working.
    private let knownVendors: @MainActor () -> [String]

    init(
        store: OutboxStore,
        api: any KeptAPI,
        recognizer: any ReceiptTextRecognizer,
        tokenStore: SessionTokenStore,
        connectivity: ConnectivityMonitor,
        backgroundContinuation: BackgroundContinuation,
        knownVendors: @escaping @MainActor () -> [String] = { ReceiptOptionsStore.cachedVendors(in: .standard) },
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.store = store
        self.api = api
        self.recognizer = recognizer
        self.tokenStore = tokenStore
        self.connectivity = connectivity
        self.backgroundContinuation = backgroundContinuation
        self.knownVendors = knownVendors
        self.now = now
    }

    /// Called once at launch: watch for connectivity and start draining.
    /// The first drain pass loads whatever survived the last run.
    func start() async {
        connectivity.start { [weak self] in
            self?.externalTrigger()
        }
        requestDrain()
    }

    // MARK: - Session identity

    /// The signed-in user, decoded from the session token. One derivation
    /// for the whole type, with one error policy: nil means signed out
    /// (or a token this app cannot read - the same thing here), a throw
    /// means the keychain read itself failed, which callers surface
    /// rather than fold into "signed out" (reviewer finding: an earlier
    /// draft's `try?` paused the queue in silence when the device locked
    /// mid-drain).
    private func currentUserId() throws -> UUID? {
        guard let token = try tokenStore.load() else { return nil }
        return SessionTokenClaims.userId(inToken: token)
    }

    /// Wired to sign-out - user-initiated or a rejected session. Any
    /// scheduled retry is pointless until someone signs back in (sign-in
    /// is itself a trigger), and the display must stop claiming the
    /// signed-out user's items. An in-flight drain pass is left to stop
    /// itself: its per-step ownership checks refuse to continue another
    /// account's work.
    func sessionDidEnd() {
        pendingRetry?.cancel()
        pendingRetry = nil
        retryDelay = Self.baseRetryDelay
        rebuildEntries()
    }

    // MARK: - Enqueue (the §7.4 save path)

    func enqueue(imageData: Data) async throws {
        try await enqueueItem(
            document: .photo(imageData),
            progress: .captured,
            confirmation: nil,
            partial: nil
        )
    }

    func enqueue(
        document: OutboxDocument,
        parsed: ParsedReceipt,
        confirmation: ConfirmedReceiptFields?,
        partial: PendingReceiptFields?
    ) async throws {
        try await enqueueItem(
            document: document,
            progress: .parsed(parsed),
            confirmation: confirmation,
            partial: partial
        )
    }

    private func enqueueItem(
        document: OutboxDocument,
        progress: OutboxItem.Progress,
        confirmation: ConfirmedReceiptFields?,
        partial: PendingReceiptFields?
    ) async throws {
        // Best-effort: loading first keeps new sequence numbers above the
        // stored ones, but a failed load must never block a save - this
        // receipt's durability outranks the ordering nicety.
        try? await ensureLoaded()
        guard let userId = try currentUserId() else {
            throw NotSignedInError()
        }
        // Claimed before any await: an interleaved enqueue gets the next
        // number, never this one.
        let sequence = nextSequence
        nextSequence += 1
        let item = OutboxItem(
            id: UUID(),
            userId: userId,
            sequence: sequence,
            capturedAt: now(),
            sha256: Self.sha256Hex(document.data),
            progress: progress,
            ocrAttempts: 0,
            confirmation: confirmation,
            partial: partial,
            contentType: document.contentType,
            ocrSource: document.ocrSource,
            // nil rather than 0 for the ordinary one-page receipt: the key
            // then stays absent from item.json, so a queue read by hand
            // looks exactly as it did before multi-page receipts existed.
            additionalPageCount: document.additionalPages.isEmpty ? nil : document.additionalPages.count
        )
        try await store.add(item, imageData: document.data, additionalPages: document.additionalPages)
        items.append(item)
        items.sort { $0.sequence < $1.sequence }
        rebuildEntries()
        // A fresh capture is the natural moment to try the network again,
        // whatever backoff an earlier failure left behind.
        externalTrigger()
    }

    /// Enqueue was asked for while no session exists - unreachable through
    /// the UI (capture lives behind sign-in) but stated, not assumed.
    struct NotSignedInError: LocalizedError {
        var errorDescription: String? {
            "You are signed out. Sign in and scan this receipt again."
        }
    }

    // MARK: - Triggers

    /// Foreground, connectivity back, sign-in, fresh capture, or a tap on
    /// Retry: reset the backoff and drain now.
    func externalTrigger() {
        pendingRetry?.cancel()
        pendingRetry = nil
        retryDelay = Self.baseRetryDelay
        requestDrain()
    }

    /// Clears a needs-attention item back into the queue and drains. The
    /// failure was called permanent, but the human asked - maybe the
    /// server was misbehaving, maybe an app update fixed the contract.
    func retryBlockedItem(id: UUID) async {
        guard let index = items.firstIndex(where: { $0.id == id }),
              items[index].blockedMessage != nil else {
            return
        }
        var item = items[index]
        item.blockedMessage = nil
        do {
            try await store.update(item)
        } catch {
            // The tap must not fail into silence: the item stays blocked,
            // and its message now says why the retry could not start.
            if let index = items.firstIndex(where: { $0.id == id }) {
                items[index].blockedMessage = "Retry could not start: \(error.localizedDescription)"
            }
            rebuildEntries()
            return
        }
        // Re-find: the awaited write is a suspension point and the queue
        // may have changed shape.
        if let index = items.firstIndex(where: { $0.id == id }) {
            items[index] = item
        }
        rebuildEntries()
        externalTrigger()
    }

    /// Deletes a needs-attention item, image and all. Only the UI's
    /// confirmed, human-initiated path calls this - the queue itself never
    /// discards anything (kickoff §3: no silent vanishing).
    func discardBlockedItem(id: UUID) async {
        guard let index = items.firstIndex(where: { $0.id == id }),
              items[index].blockedMessage != nil else {
            return
        }
        do {
            try await store.remove(itemId: id)
        } catch {
            if let index = items.firstIndex(where: { $0.id == id }) {
                items[index].blockedMessage = "Could not discard: \(error.localizedDescription)"
            }
            rebuildEntries()
            return
        }
        items.removeAll { $0.id == id }
        rebuildEntries()
    }

    /// Deletes every queued receipt belonging to an account the server has
    /// just destroyed, images and all.
    ///
    /// The other human-initiated deletion above discards one item the person
    /// looked at; this one is the local half of "delete my account and all
    /// my receipts", and leaving these behind would break that sentence
    /// twice over. The images would still be on the phone, and the items
    /// could never drain: signing in again with the same Apple ID creates a
    /// NEW user row with a new id, so every one of them would sit in the
    /// queue forever under "captured under another account".
    ///
    /// An item whose file cannot be removed keeps its row and says so, the
    /// same way discardBlockedItem does - a saved receipt never vanishes
    /// without a human hearing about it (wave-5 kickoff §3), and that is no
    /// less true when the vanishing was asked for.
    func discardAll(ownedBy userId: UUID) async {
        // Loaded first: a queue that has never been read from disk holds
        // nothing in memory, and "delete everything" would silently delete
        // the empty set.
        do {
            try await ensureLoaded()
        } catch {
            loadFailureNote = "Queued receipts could not be read from this phone: \(error.localizedDescription)"
            rebuildEntries()
            return
        }

        var failures = 0
        for item in items where item.userId == userId {
            do {
                try await store.remove(itemId: item.id)
                items.removeAll { $0.id == item.id }
            } catch {
                failures += 1
            }
        }
        if failures > 0 {
            drainFailureNote = "\(failures) queued \(failures == 1 ? "receipt" : "receipts") could not be removed from this phone."
        }
        rebuildEntries()
    }

    // MARK: - Drain

    private func requestDrain() {
        guard drainTask == nil else { return }
        drainTask = Task {
            await drain()
            drainTask = nil
        }
    }

    /// Loads the queue from disk once per run, retried on every drain
    /// until it succeeds.
    private func ensureLoaded() async throws {
        guard !hasLoadedOnce else { return }
        let loaded = try await store.loadAll()
        // Replace, not merge: the store is the source of truth, and any
        // item enqueued before this load ran was written to the store
        // first, so it is in `loaded` too.
        items = loaded.items
        unreadableCount = loaded.unreadableCount
        nextSequence = (loaded.items.map(\.sequence).max() ?? 0) + 1
        hasLoadedOnce = true
        loadFailureNote = nil
        rebuildEntries()
    }

    private func drain() async {
        // Keep an in-flight pass alive briefly if the app is pocketed
        // mid-upload; ending the grant is idempotent.
        let endContinuation = backgroundContinuation.begin()
        defer { endContinuation() }

        do {
            try await ensureLoaded()
        } catch {
            loadFailureNote = "Queued receipts could not be loaded. \(error.localizedDescription)"
            scheduleRetry()
            return
        }

        drainFailureNote = nil
        // Items set aside for this pass only: a failure that is one
        // item's own (OCR choking on one image) must not stall the queue
        // behind it. Backoff comes back for them.
        var deferredThisPass: Set<UUID> = []

        while true {
            let userId: UUID?
            do {
                userId = try currentUserId()
            } catch {
                // The keychain read itself failed - the device locked
                // mid-drain, most likely (WhenUnlocked accessibility, by
                // design). Say so and back off; the next foreground is by
                // definition unlocked.
                drainFailureNote = "Uploads are paused: \(error.localizedDescription)"
                scheduleRetry()
                break
            }
            guard let userId,
                  let item = items.first(where: {
                      $0.userId == userId
                          && $0.blockedMessage == nil
                          && !deferredThisPass.contains($0.id)
                  }) else {
                break
            }

            activeItemId = item.id
            retryMessages[item.id] = nil
            rebuildEntries()

            do {
                try await advance(item)
            } catch {
                switch classify(error) {
                case .blockItem(let message):
                    await blockItem(item.id, message: message)
                    // The failure is this item's alone and permanent; the
                    // queue behind it keeps moving.
                case .deferItem(let message):
                    // This item's alone but worth retrying (OCR, so far):
                    // set it aside for the pass and keep moving.
                    retryMessages[item.id] = message
                    deferredThisPass.insert(item.id)
                case .retryLater(let message):
                    // Almost always connectivity- or server-wide, so the
                    // whole pass stops and backs off rather than burning
                    // an attempt per item.
                    retryMessages[item.id] = message
                    activeItemId = nil
                    rebuildEntries()
                    scheduleRetry()
                    return
                case .pauseForSignIn:
                    // The session died (expired, or revoked via
                    // token_version). APIClient has already returned the
                    // app to sign-in; the queue simply waits - sign-in
                    // success is a trigger, so it resumes by itself
                    // (kickoff §3: wait, never fail permanently).
                    activeItemId = nil
                    rebuildEntries()
                    return
                }
            }
        }
        activeItemId = nil
        rebuildEntries()
        if !deferredThisPass.isEmpty {
            scheduleRetry()
        }
    }

    /// Runs the item's remaining steps in order, persisting after each so
    /// a kill resumes rather than repeats. Two re-checks bracket every
    /// step, because each await is a suspension point:
    /// - ownership: the signed-in user must still be the item's owner, or
    ///   a step begun now would run under someone else's session and
    ///   upload this receipt into their account (constraint 4);
    /// - existence: the item must still be in `items`, or its result
    ///   belongs to a receipt that was discarded meanwhile. (Defensive:
    ///   today only blocked items can be discarded and blocked items are
    ///   never advanced, but that is a UI invariant, not a structural one.)
    ///
    /// Honest residual: ownership is checked here, on the main actor, but
    /// the token itself is read again inside APIClient microseconds later.
    /// A full sign-out-and-different-sign-in landing inside that gap is
    /// not physically achievable by a human; the realistic window - a
    /// switch during a multi-second upload or create - is what these
    /// checks close. Recorded for the pre-wave-6 security review.
    private func advance(_ startingItem: OutboxItem) async throws {
        var item = startingItem
        while true {
            guard try currentUserId() == item.userId else { return }
            switch item.progress {
            case .captured:
                item = try await runOcr(on: item)
            case .parsed(let parsed):
                let image = try await store.imageData(itemId: item.id)
                // The item's own type, not a hardcoded JPEG (2026-09-01):
                // an imported PDF presigns and PUTs as application/pdf, and
                // the presigned signature covers the content type, so
                // declaring one and sending another is a silent 403.
                let contentType = item.uploadContentType
                let target = try await api.uploadTarget(contentType: contentType)
                // The presigned key was issued for whoever the session
                // names NOW. If that is no longer this item's owner, the
                // key must not stick to the item: a later create under
                // the owner's session would name a foreign object key
                // and be refused permanently.
                guard try currentUserId() == item.userId else { return }
                try await api.uploadImage(to: target, data: image, contentType: contentType)
                item.progress = .uploaded(parsed, objectKey: target.objectKey)
                try await persist(item)
            case .uploaded(let parsed, let objectKey):
                let created: Receipt?
                do {
                    created = try await api.createReceipt(
                        createRequest(for: item, parsed: parsed, objectKey: objectKey)
                    )
                } catch let apiError as APIError where Self.isDuplicateImage(apiError) {
                    // 409 from the create - and only from the create; a
                    // duplicate_image anywhere else must not delete a
                    // receipt that was never created (reviewer finding).
                    // These exact bytes are already attached to one of
                    // this user's receipts, so the receipt exists: the
                    // classic cause is a create whose response was lost.
                    // Counting it saved is recovery, not masking - the
                    // wave-4 ruling, extended to the queue.
                    created = nil
                }
                guard item.extraPageCount > 0 else {
                    await finishItem(item.id)
                    return
                }
                guard let created else {
                    // A multi-page receipt whose create came back 409:
                    // page one is attached to a receipt that exists, but
                    // the error carries no id (the server's
                    // `duplicateImageError` is a message, not a record),
                    // so this queue cannot attach the rest. Blocked and
                    // stated with its remedy rather than silently dropping
                    // pages a person scanned (kickoff §3) - the pages are
                    // still on this phone, and "Add a page" on the receipt
                    // itself is the way in.
                    await blockItem(
                        item.id,
                        message: "Page 1 of this receipt is already saved, but its other \(item.extraPageCount == 1 ? "page" : "pages") could not be attached automatically. Open that receipt and use \"Add a page\", then discard this one."
                    )
                    return
                }
                item.progress = .created(parsed, receiptId: created.id, pagesAdded: 0)
                try await persist(item)
            case .created(let parsed, let receiptId, let pagesAdded):
                guard let advanced = try await attachNextPage(
                    of: item,
                    parsed: parsed,
                    receiptId: receiptId,
                    pagesAdded: pagesAdded
                ) else {
                    return
                }
                item = advanced
                if item.extraPageCount <= pagesAdded + 1 {
                    // Every page is attached; only now does the local copy
                    // go. A kill anywhere above resumes at the page that
                    // had not landed yet, never re-creating the receipt.
                    await finishItem(item.id)
                    return
                }
            }
            guard let current = items.first(where: { $0.id == item.id }) else {
                return
            }
            item = current
        }
    }

    /// Attaches page `pagesAdded + 2` of a multi-page receipt (2026-09-01)
    /// and persists the advance, so the next page - or a relaunch - starts
    /// from the one after it.
    ///
    /// The request order is the create route's own: presign, PUT, THEN
    /// tell the API where the bytes landed. A thrown PUT exits before
    /// `addReceiptImage` is reached, by construction, so an image row can
    /// never point at bytes that were never written (spec §8's sharp
    /// edge). The ownership re-check between presign and PUT is the same
    /// one the first page gets, for the same reason.
    /// Nil when the signed-in user stopped being this item's owner
    /// mid-step; the caller stops, exactly as the first page's upload does.
    private func attachNextPage(
        of item: OutboxItem,
        parsed: ParsedReceipt,
        receiptId: UUID,
        pagesAdded: Int
    ) async throws -> OutboxItem? {
        var item = item
        let page = try await store.additionalPageData(itemId: item.id, index: pagesAdded)
        let contentType = item.uploadContentType
        let target = try await api.uploadTarget(contentType: contentType)
        guard try currentUserId() == item.userId else { return nil }
        try await api.uploadImage(to: target, data: page, contentType: contentType)
        do {
            _ = try await api.addReceiptImage(
                receiptId: receiptId,
                objectKey: target.objectKey,
                sha256: Self.sha256Hex(page)
            )
        } catch let apiError as APIError where Self.isDuplicateImage(apiError) {
            // These exact bytes are already attached to one of this user's
            // receipts - which, on this path, means this page landed and
            // the answer was lost. Counting it done is the same recovery
            // the create's own 409 gets; retrying it forever would be the
            // masking.
        }
        item.progress = .created(parsed, receiptId: receiptId, pagesAdded: pagesAdded + 1)
        try await persist(item)
        return item
    }

    /// An OCR failure wrapped so the classifier can tell "this one image
    /// is trouble" apart from "the world is trouble" - the former defers
    /// one item, the latter pauses the queue (reviewer finding: treating
    /// OCR failures as queue-wide let one unreadable page stall a whole
    /// backlog behind it).
    private struct OcrFailure: LocalizedError {
        let underlying: Error
        var errorDescription: String? {
            underlying.localizedDescription
        }
    }

    /// OCR with a bounded number of attempts, persisted on the item so
    /// relaunches do not reset the meter. Vision failing can mean a
    /// transient condition (memory pressure) or a genuinely unreadable
    /// image; retrying distinguishes them, and after maxOcrAttempts the
    /// receipt uploads with empty suggestions rather than staying hostage
    /// to its prefill.
    private func runOcr(on startingItem: OutboxItem) async throws -> OutboxItem {
        var item = startingItem
        let image = try await store.imageData(itemId: item.id)
        do {
            let recognized = try await recognizer.recognizeText(in: image)
            // The item's own capture instant, not "now": a batch scanned
            // offline on Friday can drain on Monday, and the date heuristic
            // scores every reading against when the photograph was taken
            // (2026-09-01).
            let suggestions = ReceiptParser.parse(
                lines: recognized.lines,
                capturedAt: item.capturedAt,
                knownVendors: knownVendors()
            )
            item.progress = .parsed(ParsedReceipt(
                suggestions: suggestions,
                ocrRawText: recognized.rawText.isEmpty ? nil : recognized.rawText
            ))
        } catch {
            item.ocrAttempts += 1
            if item.ocrAttempts >= Self.maxOcrAttempts {
                item.progress = .parsed(ParsedReceipt(suggestions: ReceiptSuggestions(), ocrRawText: nil))
            } else {
                // Memory first, disk best-effort - the one inversion of
                // the persist() convention, for two reviewer-found
                // reasons: a failing disk write must not replace the OCR
                // error (the signal the queue needs to carry), and the
                // attempt count must advance in memory regardless, or a
                // persistently failing store would make the cap
                // unreachable and retry this image forever.
                applyInMemory(item)
                try? await store.update(item)
                throw OcrFailure(underlying: error)
            }
        }
        try await persist(item)
        return item
    }

    private func createRequest(
        for item: OutboxItem,
        parsed: ParsedReceipt,
        objectKey: String
    ) -> CreateReceiptRequest {
        let suggestions = parsed.suggestions
        if let confirmed = item.confirmation {
            // Confirmed at capture (the single-capture flow): the human's
            // fields land as a `confirmed` row directly - it never joins
            // the pending queue. The parser's suggestions still ride
            // along verbatim, because comparing them with these confirmed
            // fields IS the §7.3 accuracy measurement.
            return CreateReceiptRequest(
                purchasedAt: confirmed.purchasedAt,
                capturedAt: ReceiptFormat.timestamp(of: item.capturedAt),
                vendor: confirmed.vendor,
                subtotalCents: confirmed.subtotalCents,
                hstCents: confirmed.hstCents,
                totalCents: confirmed.totalCents,
                tipCents: confirmed.tipCents,
                otherFeesCents: confirmed.otherFeesCents,
                category: confirmed.category,
                paymentMethod: confirmed.paymentMethod,
                notes: confirmed.notes,
                status: .confirmed,
                ocrRawText: parsed.ocrRawText,
                // How the text was actually read (2026-09-01): a
                // photograph Vision read, or - since the PDF import - an
                // emailed PDF's own text layer. The server's merge treats
                // the two differently for money fields, so guessing here
                // would change which suggestions a person is offered.
                ocrSource: item.uploadOcrSource.rawValue,
                ocrSuggestions: OcrSuggestionsPayload(suggestions),
                reviewedFields: confirmed.reviewedFields,
                image: CreateReceiptRequest.Image(objectKey: objectKey, sha256: item.sha256)
            )
        }
        // The capture-time "Later" exit, since 2026-09-01: whatever the
        // person had typed into the confirm form before leaving it rides
        // in `item.partial`, and its own reviewed set decides column by
        // column which of the two sources this create sends. Reviewed
        // means the human's value goes in - INCLUDING when that value is
        // nil, because "I looked and there is nothing on the paper" must
        // leave the column empty rather than let the parser's guess back
        // in. Everything unreviewed keeps sending the heuristic snapshot,
        // exactly as it did before this existed.
        let partial = item.partial
        func typedOrParsed<Value>(_ field: ReviewedField, _ typed: Value?, _ parsed: Value?) -> Value? {
            partial?.reviewed(field) == true ? typed : parsed
        }
        return CreateReceiptRequest(
            // The parser's date when it found one; otherwise the capture
            // day - the day the person scanned it, not the day the upload
            // finally went through, which after an offline weekend can
            // differ. The confirm screen presents either as a
            // suggestion to be confirmed (§7.2).
            purchasedAt: typedOrParsed(.purchasedAt, partial?.purchasedAt, suggestions.purchasedAt)
                ?? ReceiptFormat.calendarDate(of: item.capturedAt),
            capturedAt: ReceiptFormat.timestamp(of: item.capturedAt),
            vendor: typedOrParsed(.vendor, partial?.vendor, suggestions.vendor),
            subtotalCents: typedOrParsed(.subtotalCents, partial?.subtotalCents, suggestions.subtotalCents),
            hstCents: typedOrParsed(.hstCents, partial?.hstCents, suggestions.hstCents),
            totalCents: typedOrParsed(.totalCents, partial?.totalCents, suggestions.totalCents),
            // The heuristic's tip and fee guesses ride along like every
            // other amount here.
            tipCents: typedOrParsed(.tipCents, partial?.tipCents, suggestions.tipCents),
            otherFeesCents: typedOrParsed(.otherFeesCents, partial?.otherFeesCents, suggestions.otherFeesCents),
            // Category and notes have no parser behind them at all, so
            // they are sent only when a human typed one - which, before
            // the capture screen's "Later" carried anything, never
            // happened and so was not sent at all.
            category: typedOrParsed(.category, partial?.category, nil),
            paymentMethod: typedOrParsed(.paymentMethod, partial?.paymentMethod, suggestions.paymentMethod),
            notes: typedOrParsed(.notes, partial?.notes, nil),
            ocrRawText: parsed.ocrRawText,
            ocrSource: item.uploadOcrSource.rawValue,
            ocrSuggestions: OcrSuggestionsPayload(suggestions),
            reviewedFields: partial?.reviewedFields,
            image: CreateReceiptRequest.Image(objectKey: objectKey, sha256: item.sha256)
        )
    }

    // MARK: - Item state changes

    /// The server has the receipt; the local copy has done its job.
    private func finishItem(_ id: UUID) async {
        do {
            try await store.remove(itemId: id)
        } catch {
            // The receipt IS on the server, so it leaves the visible
            // queue regardless; the undeleted files resurface at next
            // launch and their retried create lands on the 409 path -
            // saved exactly once either way. Stated, because if the disk
            // stays broken this repeats every launch and an unexplained
            // reappearing receipt would look like a haunting.
            drainFailureNote = "A saved receipt's local copy could not be removed: \(error.localizedDescription)"
        }
        items.removeAll { $0.id == id }
        retryMessages[id] = nil
        // A confirmed receipt proves the path works; the next failure, if
        // any, deserves a fresh backoff clock.
        retryDelay = Self.baseRetryDelay
        serverConfirmedCount += 1
        rebuildEntries()
    }

    private func blockItem(_ id: UUID, message: String) async {
        guard let index = items.firstIndex(where: { $0.id == id }) else { return }
        var item = items[index]
        item.blockedMessage = message
        // If persisting the block fails, it holds in memory for this run;
        // after a relaunch the item auto-retries once more and either the
        // 4xx reproduces (re-blocked, one wasted request per launch) or
        // it does not (the retry was right). Both outcomes are correct,
        // just not silent-forever loops.
        try? await store.update(item)
        if let index = items.firstIndex(where: { $0.id == id }) {
            items[index] = item
        }
        rebuildEntries()
    }

    private func persist(_ item: OutboxItem) async throws {
        try await store.update(item)
        applyInMemory(item)
    }

    private func applyInMemory(_ item: OutboxItem) {
        if let index = items.firstIndex(where: { $0.id == item.id }) {
            items[index] = item
        }
    }

    // MARK: - Failure classification

    /// Every failure in the drain is routed through here or the create's
    /// own duplicate-409 catch; there is no other catch. This is the map
    /// the kickoff's §3 failure modes hang off, and the place a swallowed
    /// error would be invisible - so every case carries its message to
    /// the UI.
    private enum FailureAction {
        case retryLater(message: String)
        case deferItem(message: String)
        case blockItem(message: String)
        case pauseForSignIn
    }

    private func classify(_ error: Error) -> FailureAction {
        switch error {
        case let apiError as APIError:
            switch apiError {
            case .sessionRejected:
                return .pauseForSignIn
            case .requestFailed(_, let message, let status):
                // Timeout-shaped and rate-limit statuses are the server
                // asking for patience, not refusing the request.
                if status == 408 || status == 429 {
                    return .retryLater(message: message)
                }
                if (400..<500).contains(status) {
                    // A request the server will refuse every time - a
                    // contract bug, not weather. Retrying forever would
                    // burn the queue behind it; the item blocks instead
                    // and waits for a human (kickoff §3).
                    return .blockItem(message: message)
                }
                return .retryLater(message: message)
            case .network(let urlError):
                return .retryLater(message: urlError.localizedDescription)
            case .unexpectedResponse(let status):
                // Includes presigned PUT failures (storage answers XML,
                // not the API envelope). A 403 there usually means the
                // URL expired while queued - the retry gets a fresh one,
                // so this is never permanent.
                return .retryLater(message: "The server answered unexpectedly (HTTP \(status)).")
            case .undecodableResponse:
                // A 2xx whose body we couldn't read - the create may well
                // have landed. The retry either succeeds or hits the 409
                // recovery path; both end with the receipt saved once.
                return .retryLater(message: "The server's answer could not be read.")
            }
        case let ocrFailure as OcrFailure:
            // One image's trouble, not the queue's: set this item aside
            // and keep the rest moving. The persisted attempt cap bounds
            // how long a genuinely broken image can keep this up.
            return .deferItem(message: ocrFailure.localizedDescription)
        case let missingImage as OutboxMissingImageError:
            // The image bytes are gone from disk; no retry can bring them
            // back. Block and tell the human - the paper may still exist.
            return .blockItem(message: missingImage.localizedDescription)
        case let locked as OutboxLockedError:
            // Complete file protection refused the read because the phone
            // is locked. Same shape as the keychain case below, and the
            // same answer: the next foreground is by definition unlocked.
            // Never .blockItem - the bytes are intact, and telling someone
            // a receipt is unrecoverable because their phone was in their
            // pocket is the worst answer this queue can give.
            return .retryLater(message: locked.localizedDescription)
        case let keychainError as KeychainError:
            // The device locked mid-drain (WhenUnlocked accessibility, by
            // design). The next foreground is by definition unlocked.
            return .retryLater(message: keychainError.localizedDescription)
        default:
            // Store read/write failures and anything unforeseen: retry
            // with backoff, reason attached.
            return .retryLater(message: error.localizedDescription)
        }
    }

    private func scheduleRetry() {
        guard pendingRetry == nil else { return }
        let delay = retryDelay
        retryDelay = min(retryDelay * 2, Self.maxRetryDelay)
        pendingRetry = Task {
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            pendingRetry = nil
            requestDrain()
        }
    }

    // MARK: - Presentation

    private func rebuildEntries() {
        let userId: UUID?
        do {
            userId = try currentUserId()
        } catch {
            userId = nil
        }
        guard let userId else {
            // Signed out (or the keychain is refusing reads, which the
            // drain reports separately). Nobody's items render - above
            // all, the signed-out user's own captures must not be
            // mislabelled "another account's" (reviewer finding).
            entries = []
            otherAccountCount = 0
            return
        }
        var visible: [Entry] = []
        var foreign = 0
        for item in items {
            guard item.userId == userId else {
                foreign += 1
                continue
            }
            let status: Entry.Status
            if let message = item.blockedMessage {
                status = .needsAttention(message: message)
            } else if item.id == activeItemId {
                status = .processing
            } else if let message = retryMessages[item.id] {
                status = .waitingToRetry(message: message)
            } else {
                status = .waiting
            }
            visible.append(Entry(id: item.id, capturedAt: item.capturedAt, status: status))
        }
        entries = visible
        otherAccountCount = foreign
    }

    // MARK: - Hashing

    private static func isDuplicateImage(_ error: APIError) -> Bool {
        if case .requestFailed(let code, _, _) = error {
            return code == "duplicate_image"
        }
        return false
    }

    private static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data)
            .map { String(format: "%02x", $0) }
            .joined()
    }
}

extension OutboxController: OutboxEnqueuing {}
