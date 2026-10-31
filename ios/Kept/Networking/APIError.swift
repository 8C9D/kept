import Foundation

/// Every way a call to the Kept API can fail, mapped in exactly one place
/// (APIClient). View models never inspect status codes or response bodies;
/// they see one of these cases and, for display, its `errorDescription`.
enum APIError: Error {
    /// The server refused the session token (or no token was stored at
    /// all). By the time this is thrown from an ordinary call the app has
    /// already been returned to signed-out, and whatever screen was waiting
    /// on the call is gone. A best-effort call (`SessionFailureHandling`)
    /// throws it too and ends nothing: it is how such a caller hears "not
    /// with this session", which it ignores.
    case sessionRejected

    /// The server answered with its structured error shape
    /// `{error: {code, message}}` - a 400 for a bad request, a 404 for a
    /// missing receipt, a 401 for a rejected Apple identity token at
    /// sign-in.
    case requestFailed(code: String, message: String, status: Int)

    /// 409 `duplicate_image` from a server that says which of the caller's
    /// own receipts already holds those bytes (2026-10-31). Its own case
    /// because the id is what the outbox needs to finish a multi-page
    /// receipt; a server that sends no id still answers `requestFailed`,
    /// and `isDuplicateImage` below reads the two as one fact.
    case duplicateImage(existingReceiptId: UUID, message: String)

    /// The request never completed: no connectivity, timeout, refused
    /// connection. The one case that means "the server may be fine".
    case network(URLError)

    /// A non-2xx response whose body was not the API's error shape - a
    /// proxy error page, for instance. The status is all we reliably know.
    case unexpectedResponse(status: Int)

    /// A 2xx response whose body did not decode into the expected model.
    /// Always a bug - a contract drift between this app and the server.
    case undecodableResponse(DecodingError)
}

extension APIError {
    /// These exact bytes are already attached to one of this user's
    /// receipts - with or without the id that says which.
    var isDuplicateImage: Bool {
        switch self {
        case .duplicateImage:
            return true
        case .requestFailed(let code, _, _):
            return code == "duplicate_image"
        default:
            return false
        }
    }

    /// Which receipt holds those bytes, when the server said.
    var existingReceiptId: UUID? {
        if case .duplicateImage(let id, _) = self { return id }
        return nil
    }

    /// Whether this failure leaves open that the request took effect
    /// anyway: the response was lost, or the server fell over after doing
    /// the work. A 4xx is a refusal, and a refusal changed nothing. Two
    /// callers that cannot simply retry ask this - an add-page whose retry
    /// would 409 on its own success, and an account deletion that may
    /// already have happened.
    var outcomeIsUnknown: Bool {
        switch self {
        case .network, .unexpectedResponse, .undecodableResponse:
            return true
        case .requestFailed(_, _, let status):
            return status >= 500
        case .sessionRejected, .duplicateImage:
            return false
        }
    }
}

extension APIError: LocalizedError {
    /// The single source of user-facing failure text. Views show this
    /// string (via `localizedDescription`) rather than composing their own.
    var errorDescription: String? {
        switch self {
        case .sessionRejected:
            return "Your session has expired. Sign in again."
        case .requestFailed(_, let message, _), .duplicateImage(_, let message):
            return message
        case .network(let urlError):
            return "Could not reach the server: \(urlError.localizedDescription)"
        case .unexpectedResponse(let status):
            return "The server answered unexpectedly (HTTP \(status))."
        case .undecodableResponse:
            return "The server's answer could not be read. This is a bug."
        }
    }
}
