import Foundation

/// The three remembered-value lists a person can manage (2026-09-01) -
/// the verbatim mirror of the server's `ReceiptOptionApiField`, whose
/// names are the `:field` path segment of the rename and delete routes.
///
/// `category`, `paymentMethod` and `vendor` are and stay free text
/// (engineering rule: never an enum, never a taxonomy). This enum names
/// the three LISTS, not the values in them - which is why it can be
/// closed while the values it points at never will be.
enum ReceiptOptionField: String, CaseIterable, Identifiable, Sendable {
    case vendor
    case category
    case paymentMethod

    var id: String { rawValue }

    /// The list's own heading.
    var title: String {
        switch self {
        case .vendor: return "Vendors"
        case .category: return "Categories"
        case .paymentMethod: return "Payment methods"
        }
    }

    /// The field as it reads inside a sentence ("the payment-method
    /// list") - the same wording the web client's `optionFieldNoun` uses,
    /// so the two screens describe the same act the same way.
    var noun: String {
        switch self {
        case .vendor: return "vendor"
        case .category: return "category"
        case .paymentMethod: return "payment method"
        }
    }

    /// What an empty list means. Never "none available": these lists fill
    /// themselves from what the person has already confirmed, and saying
    /// so is the difference between an empty screen and a broken one.
    var emptyNote: String {
        "No \(noun == "category" ? "categories" : "\(noun)s") yet - they appear as you confirm receipts."
    }

    /// This field's values out of a fetched options set.
    func values(in options: ReceiptOptions) -> [String] {
        switch self {
        case .vendor: return options.vendors
        case .category: return options.categories
        case .paymentMethod: return options.paymentMethods
        }
    }
}
