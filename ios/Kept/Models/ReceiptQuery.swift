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
    /// The same rule as `category`, over the other reusable free-text
    /// field.
    var paymentMethod: String?
    /// Inclusive `purchased_at` bounds as yyyy-mm-dd - the date on the
    /// receipt, not the day it was scanned, whatever `sort` is set to.
    /// Each side is independently optional: "everything since April" and
    /// "everything up to year end" are both real questions.
    var from: String?
    var to: String?
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
        searchTerm != nil
            || status != nil
            || category != nil
            || paymentMethod != nil
            || from != nil
            || to != nil
    }

    /// A range whose start is after its end. The server answers it
    /// honestly with nothing, which on screen is indistinguishable from
    /// "you have no receipts in April" - so the screen says which.
    var hasImpossibleDateRange: Bool {
        guard let from, let to else { return false }
        // Both are yyyy-mm-dd, so lexical order is calendar order.
        return from > to
    }

    /// How the applied range reads on the control that opens it. The
    /// locale parameter exists for tests, which pin one; the app always
    /// uses the person's.
    func dateRangeLabel(locale: Locale = .autoupdatingCurrent) -> String {
        switch (from, to) {
        case (nil, nil):
            return "Any date"
        case (let from?, nil):
            return "From \(ReceiptFormat.purchaseDate(from, locale: locale))"
        case (nil, let to?):
            return "Until \(ReceiptFormat.purchaseDate(to, locale: locale))"
        case (let from?, let to?):
            // Spelled out on both ends rather than abbreviated to a shared
            // year: a range is the filter most likely to be wrong by a
            // year, and this is where it would show.
            return "\(ReceiptFormat.purchaseDate(from, locale: locale)) - "
                + ReceiptFormat.purchaseDate(to, locale: locale)
        }
    }

    /// `sort` and `order` are always sent, including at their defaults:
    /// the cursor encodes what it was minted under, and a request that
    /// omitted them would rely on the server's default matching this
    /// client's forever. Everything else is sent only when set - the
    /// server's schema is strict and rejects an empty `q`, `category` or
    /// `paymentMethod`.
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
        if let paymentMethod {
            items.append(URLQueryItem(name: "paymentMethod", value: paymentMethod))
        }
        if let from {
            items.append(URLQueryItem(name: "from", value: from))
        }
        if let to {
            items.append(URLQueryItem(name: "to", value: to))
        }
        items.append(URLQueryItem(name: "sort", value: sort.rawValue))
        items.append(URLQueryItem(name: "order", value: order.rawValue))
        return items
    }
}
