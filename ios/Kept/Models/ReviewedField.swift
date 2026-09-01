import Foundation

/// Which fields on a PENDING receipt a human has actually entered or
/// looked at and accepted (2026-09-01, server migration 0009) - the
/// verbatim mirror of `REVIEWED_FIELDS` in
/// `server/src/domain/reviewedFields.ts`, and of the web form's
/// `ReviewedField`. Read that file's own doc comment first; only enough is
/// restated here to keep the three in step.
///
/// The problem it solves: a pending receipt is a draft the person may come
/// back to after the app was killed mid-confirm, or on the other client.
/// Every read path serves `suggestions` alongside the stored row, and both
/// clients prefill an empty field from its suggestion - correct for a
/// field nobody has touched, wrong for one a human already typed. Without
/// this record the server cannot tell the two apart: "the total is 1435
/// because the parser said so" and "the total is 1435 because a person
/// read the paper and typed it" are the same column value. So the client
/// states which is which, and the server serves a reviewed field's
/// suggestion as ABSENT.
///
/// It is deliberately a record of REVIEW, not of edit: a person who reads
/// the parser's vendor, agrees with it and moves on has reviewed that
/// field just as much as one who retyped it.
///
/// ⚠ The vocabulary is CLOSED and these are FIELD NAMES, never values -
/// the same class of thing `EventField` is, and for the same privacy
/// reason: a column that could hold arbitrary client text is a column a
/// receipt's contents leak into. `String`-backed for exactly the reason
/// `EventAction` is: a name this client cannot spell is a compile error
/// here rather than a rejected request at runtime.
enum ReviewedField: String, Codable, Equatable, Hashable, CaseIterable, Sendable {
    case purchasedAt
    case vendor
    case subtotalCents
    case hstCents
    case tipCents
    case otherFeesCents
    case totalCents
    case category
    case paymentMethod
    case notes

    /// A stored set, decoded from a receipt response's `reviewedFields`.
    ///
    /// A name this build does not know is DROPPED rather than carried:
    /// every write that reports a reviewed set replaces the stored one
    /// outright, and the server's strict schema 400s an unlisted name, so
    /// echoing an unknown one back is not something this client can do.
    /// The cost is that a field a newer client reviewed would be offered
    /// its suggestion again here - visible and harmless - where the
    /// alternative is a save that fails outright. There is nothing to drop
    /// today: this enum and the server's array are the same ten names.
    static func set(fromWire names: [String]?) -> Set<ReviewedField> {
        Set((names ?? []).compactMap(ReviewedField.init(rawValue:)))
    }

    /// A set in the vocabulary's own declared order, so the same set
    /// always serializes the same way - a request body that varies with
    /// the order fields happened to be touched in is one no test can pin.
    /// Mirrors the web's `reviewedFieldsForSave`, which orders by
    /// `REVIEWED_FIELDS` for the identical reason.
    static func ordered(_ fields: Set<ReviewedField>) -> [ReviewedField] {
        allCases.filter(fields.contains)
    }
}
