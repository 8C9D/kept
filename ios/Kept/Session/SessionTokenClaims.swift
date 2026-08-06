import Foundation

/// Reads the user id out of the app's own session JWT (the `sub` claim the
/// server sets - server/src/auth/session.ts).
///
/// Deliberately no signature verification: the client makes no trust
/// decision here and could not meaningfully verify an HS256 token anyway
/// (the key is the server's secret). The id labels queued outbox items
/// with who captured them so the drain never uploads them under a
/// different account; the server independently authenticates every actual
/// request from the token itself.
enum SessionTokenClaims {
    static func userId(inToken token: String) -> UUID? {
        let segments = token.split(separator: ".")
        guard segments.count == 3,
              let payload = base64URLDecode(String(segments[1])) else {
            return nil
        }
        struct Claims: Decodable {
            let sub: String
        }
        guard let claims = try? JSONDecoder().decode(Claims.self, from: payload) else {
            return nil
        }
        return UUID(uuidString: claims.sub)
    }

    /// JWT segments are base64url without padding; Foundation's decoder
    /// wants standard base64 with it.
    private static func base64URLDecode(_ input: String) -> Data? {
        var base64 = input
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let remainder = base64.count % 4
        if remainder > 0 {
            base64.append(String(repeating: "=", count: 4 - remainder))
        }
        return Data(base64Encoded: base64)
    }
}
