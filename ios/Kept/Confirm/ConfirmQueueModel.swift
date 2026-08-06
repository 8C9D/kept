import Foundation

/// "Next unconfirmed receipt" as a repeatable action (spec §6A): fetch the
/// next pending receipt, hand its confirm form to the view, and when it
/// saves - or the person sets it aside - fetch the next, until the queue
/// is empty. A batch scanned moments ago and a backlog pending since last
/// week are worked down identically, because both are just pending rows.
@MainActor
final class ConfirmQueueModel: ObservableObject {
    enum Phase {
        case loading
        case confirming(ConfirmReceiptModel)
        case failed(String)
        /// No pending receipts remain - counting any set aside this
        /// sitting, which stay pending and keep the Home badge honest.
        case done(setAsideCount: Int)
    }

    @Published private(set) var phase: Phase = .loading
    /// The user's total pending count, from the same server field as the
    /// Home badge - "3 left" over the queue is that number.
    @Published private(set) var pendingCount: Int?
    /// Receipts this sitting has dealt with - confirmed or set aside.
    /// The done screen shows a summary only when there was a batch to
    /// summarize; after a single capture it must return straight to Home,
    /// because a one-line recap of a five-second task is the success modal
    /// §10A.1 forbids (wave-4 device run, the owner's finding 1).
    @Published private(set) var handledCount = 0

    private let api: any KeptAPI
    /// Receipts set aside this sitting. Server-side they stay pending;
    /// the queue just stops re-offering them until reopened.
    private var setAsideIds: Set<UUID> = []
    private var isLoadingNext = false

    /// The queue asks for a page this size and takes the first receipt not
    /// set aside; larger than any realistic single-sitting set-aside pile.
    private static let pageSize = 50

    init(api: any KeptAPI) {
        self.api = api
    }

    func loadNext() async {
        guard !isLoadingNext else { return }
        isLoadingNext = true
        defer { isLoadingNext = false }

        phase = .loading
        do {
            let page = try await api.receiptsPage(
                cursor: nil,
                status: .pending,
                limit: Self.pageSize
            )
            pendingCount = page.pendingCount
            guard let next = page.receipts.first(where: { !setAsideIds.contains($0.id) }) else {
                phase = .done(setAsideCount: setAsideIds.count)
                return
            }
            // The detail fetch brings what the list omits: the presigned
            // image URL the person checks the numbers against.
            let detail = try await api.receiptDetail(id: next.id)
            phase = .confirming(ConfirmReceiptModel(api: api, detail: detail))
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    /// "This one later": keep it pending, move on. The §5.2a badge keeps
    /// nagging about it, which is the design.
    func setAsideCurrent() async {
        if case .confirming(let model) = phase {
            setAsideIds.insert(model.receiptId)
            handledCount += 1
        }
        await loadNext()
    }

    /// Called by the view after the current form saves successfully.
    func advanceAfterSave() async {
        handledCount += 1
        await loadNext()
    }
}
