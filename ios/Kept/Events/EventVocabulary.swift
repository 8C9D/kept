import Foundation

/// The behavioural-telemetry vocabulary this client is allowed to send,
/// mirrored verbatim from the server's fixed enumerations
/// (server/src/domain/userEvents.ts EVENT_ACTIONS/EVENT_FIELDS/
/// EVENT_CLIENTS). The server's wire schema (http/schemas.ts, `z.enum`
/// over these same arrays) is what actually stops an unlisted value from
/// ever reaching a row - mirroring the closed set here is what stops this
/// client from ever trying to send one in the first place, and gets the
/// mistake caught at compile time instead of as a lost batch at runtime.
///
/// Deliberately `String`-backed enums, not free strings: exactly the
/// server's own reasoning ("a new action name is a code change here plus
/// a client release, never a migration") applies symmetrically on this
/// side.
enum EventAction: String, Encodable, Equatable {
    case signIn = "sign_in"
    case signOut = "sign_out"
    case captureStarted = "capture_started"
    case captureCompleted = "capture_completed"
    case captureCancelled = "capture_cancelled"
    case confirmOpened = "confirm_opened"
    case confirmSaved = "confirm_saved"
    case confirmDeferred = "confirm_deferred"
    case fieldEdited = "field_edited"
    case suggestionAccepted = "suggestion_accepted"
    case suggestionOverridden = "suggestion_overridden"
    case receiptViewed = "receipt_viewed"
    case receiptEdited = "receipt_edited"
    case receiptDeleted = "receipt_deleted"
    case listSearched = "list_searched"
    case listFiltered = "list_filtered"
    case listSorted = "list_sorted"
    case imageOpened = "image_opened"
    case imageZoomed = "image_zoomed"
    case optionReused = "option_reused"
    case exportRequested = "export_requested"
    case exportDownloaded = "export_downloaded"
    case exportFailed = "export_failed"
    // `account_deleted` is in the server's vocabulary but nothing on this
    // client emits it (2026-08-28 brief covers 20 actions plus
    // field_edited/suggestion_*; account_deleted is not among them). It
    // would also race the same way SessionController.signOut()'s event
    // does - the session that authenticates the POST is gone by the time
    // deletion completes - which is one more reason not to reach for it
    // here.
}

/// Which receipt field an action concerns. Matches
/// ConfirmReceiptModel.EditableField's cases one for one, plus
/// `purchasedAt` for the date picker, which raises no keyboard and so has
/// no EditableField case of its own (see EditableField.eventField).
enum EventField: String, Encodable, Equatable {
    case total, purchasedAt, vendor, hst, subtotal, tip
    case otherFees, category, paymentMethod, notes
}

/// Which client produced the event. Always `.ios` here; the server's
/// vocabulary also names `web` for the other client, which this app never
/// sends.
enum EventClient: String, Encodable, Equatable {
    case ios
}
