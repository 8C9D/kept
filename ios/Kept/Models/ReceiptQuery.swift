import Foundation

/// What a list request is asking for, beyond the page cursor: the search
/// term, the filters, and the ordering (2026-08-26 field reduction).
///
/// It is one value rather than five parameters because the server binds
/// them together: a keyset cursor encodes the sort it was minted under and
/// is refused against a different one, so every caller that changes any of
/// this has to start again from page one. Carrying them as a unit is what
/// makes "the query changed" a single comparison.
///
/// All of it is server-side. The client does not sort, filter or search a
/// page it already has - that would show a different answer than the next
/// page would (spec §4.1: no domain logic here).
struct ReceiptQuery: Equatable {
    /// The server's `sort` parameter. `purchasedAt` is the date on the
    /// receipt; `capturedAt` is when it was scanned.
    enum Sort: String, CaseIterable, Identifiable {
        case purchasedAt, capturedAt, total, vendor

        var id: String { rawValue }

        var label: String {
            switch self {
            case .purchasedAt: return "Receipt date"
            case .capturedAt: return "Capture date"
            case .total: return "Total"
            case .vendor: return "Vendor"
            }
        }

        /// What descending and ascending mean for this key, said in the
        /// key's own terms - "Newest first" reads; "Descending" makes the
        /// reader work out what it is descending on.
        func orderLabel(_ order: Order) -> String {
            switch self {
            case .purchasedAt, .capturedAt:
                return order == .desc ? "Newest first" : "Oldest first"
            case .total:
                return order == .desc ? "Largest first" : "Smallest first"
            case .vendor:
                return order == .desc ? "Z to A" : "A to Z"
            }
        }
    }

    enum Order: String {
        case asc, desc
    }

    /// The search box's raw text. Trimmed and dropped when blank on the
    /// way out: the server's `q` has a minimum length of 1 and would
    /// reject an empty one.
    var search: String = ""
    var status: ReceiptStatus?
    /// Exact-match against the stored free text, paired with the values
    /// GET /api/receipts/options serves. Never normalized here - the
    /// person's category is whatever they typed.
    var category: String?
    var sort: Sort = .purchasedAt
    var order: Order = .desc

    /// The default the list opens on: receipt date, newest first - the
    /// same ordering the app has always shown.
    static let `default` = ReceiptQuery()

    var searchTerm: String? {
        let trimmed = search.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// True when anything other than the ordering is narrowing the list -
    /// what the toolbar badge keys off, so the person can see that rows
    /// are missing on purpose.
    var isFiltering: Bool {
        searchTerm != nil || status != nil || category != nil
    }

    /// `sort` and `order` are always sent, including at their defaults:
    /// the cursor encodes what it was minted under, and a request that
    /// omitted them would rely on the server's default matching this
    /// client's forever.
    var queryItems: [URLQueryItem] {
        var items: [URLQueryItem] = []
        if let searchTerm {
            items.append(URLQueryItem(name: "q", value: searchTerm))
        }
        if let status {
            items.append(URLQueryItem(name: "status", value: status.rawValue))
        }
        if let category {
            items.append(URLQueryItem(name: "category", value: category))
        }
        items.append(URLQueryItem(name: "sort", value: sort.rawValue))
        items.append(URLQueryItem(name: "order", value: order.rawValue))
        return items
    }
}
