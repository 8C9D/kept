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

    private let api: any KeptAPI

    init(api: any KeptAPI) {
        self.api = api
    }

    func load(id: UUID) async {
        phase = .loading
        do {
            phase = .loaded(try await api.receiptDetail(id: id))
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }
}
