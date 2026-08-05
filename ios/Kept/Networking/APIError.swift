import Foundation

/// Every way a call to the Kept API can fail, mapped in exactly one place
/// (APIClient). View models never inspect status codes or response bodies;
/// they see one of these cases and, for display, its `errorDescription`.
enum APIError: Error {
    /// The server refused the session token (or no token was stored at
    /// all). By the time this is thrown the app has already been returned
    /// to signed-out; whatever screen was waiting on the call is gone.
    case sessionRejected

    /// The server answered with its structured error shape
    /// `{error: {code, message}}` - a 400 for a bad request, a 404 for a
    /// missing receipt, a 401 for a rejected Apple identity token at
    /// sign-in.
    case requestFailed(code: String, message: String, status: Int)

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

extension APIError: LocalizedError {
    /// The single source of user-facing failure text. Views show this
    /// string (via `localizedDescription`) rather than composing their own.
    var errorDescription: String? {
        switch self {
        case .sessionRejected:
            return "Your session has expired. Sign in again."
        case .requestFailed(_, let message, _):
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
