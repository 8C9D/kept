import Foundation

/// Fetches one receipt's full record - fields, OCR text, presigned image
/// URLs - for the read-only detail screen.
@MainActor
final class ReceiptDetailModel: ObservableObject {
    enum Phase: Equatable {
        case loading
        case loaded(ReceiptDetail)
        case failed(String)
    }

    @Published private(set) var phase: Phase = .loading
    @Published private(set) var isDeleting = false
    /// Why a delete did not happen, when it did not. Separate from `phase`
    /// (which is about loading the record, not mutating it) - same
    /// reasoning as SessionController.AccountDeletion being its own value
    /// rather than folded into signed-in/signed-out state.
    @Published private(set) var deleteError: String?

    private let api: any KeptAPI
    private let eventLogger: EventLogger

    init(api: any KeptAPI, eventLogger: EventLogger) {
        self.api = api
        self.eventLogger = eventLogger
    }

    func load(id: UUID) async {
        phase = .loading
        do {
            let detail = try await api.receiptDetail(id: id)
            phase = .loaded(detail)
            // `receipt_viewed` (2026-08-28): fires on every successful
            // load, including the re-load after a save - "the person is
            // looking at this receipt's detail screen" is true both times,
            // and the save itself already logs its own event
            // (confirm_saved/receipt_edited, ConfirmReceiptView).
            eventLogger.log(.receiptViewed, receiptId: id)
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    /// Soft-deletes this receipt (spec §10B: tombstoned, bytes kept for
    /// retention - not erased). Returns whether it succeeded, the same
    /// shape as ConfirmReceiptModel.save(), so the view dismisses back to
    /// the list only on a real success rather than guessing from state.
    func delete(id: UUID) async -> Bool {
        guard !isDeleting else { return false }
        isDeleting = true
        deleteError = nil
        defer { isDeleting = false }

        do {
            try await api.deleteReceipt(id: id)
            eventLogger.log(.receiptDeleted, receiptId: id)
            return true
        } catch {
            deleteError = error.localizedDescription
            return false
        }
    }

    func clearDeleteError() {
        deleteError = nil
    }
}
