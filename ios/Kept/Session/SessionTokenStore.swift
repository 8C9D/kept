import Foundation
import Security

/// Where the session JWT lives between launches. The keychain, never
/// UserDefaults: UserDefaults is a plaintext plist inside the app
/// container, included in unencrypted backups - the wrong place for a
/// bearer credential.
protocol SessionTokenStore {
    /// The stored token, or nil when signed out.
    func load() throws -> String?
    func save(_ token: String) throws
    /// Removing an already-absent token is a success, not an error.
    func clear() throws
}

/// A keychain operation that failed for a reason other than "not found".
/// The OSStatus is carried so the failure is diagnosable, not summarized
/// away.
struct KeychainError: Error {
    let operation: String
    let status: OSStatus
}

extension KeychainError: LocalizedError {
    var errorDescription: String? {
        "Keychain \(operation) failed (OSStatus \(status))."
    }
}

final class KeychainSessionTokenStore: SessionTokenStore {
    private let service: String
    private let account: String

    /// The defaults are the app's one real token slot; tests pass their own
    /// service so they never touch it.
    init(service: String = "com.arthurzhang.kept", account: String = "session-token") {
        self.service = service
        self.account = account
    }

    func load() throws -> String? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        switch status {
        case errSecSuccess:
            guard let data = result as? Data, let token = String(data: data, encoding: .utf8) else {
                // A found item that is not UTF-8 text is corrupt storage,
                // not a signed-out state; stay loud.
                throw KeychainError(operation: "read", status: errSecDecode)
            }
            return token
        case errSecItemNotFound:
            return nil
        default:
            throw KeychainError(operation: "read", status: status)
        }
    }

    /// The strictest accessibility that works today: the app only reads the
    /// token in the foreground. The wave-5 background outbox will need
    /// AfterFirstUnlock; that wave changes this one constant, and because
    /// the update path below re-asserts it, existing installs migrate on
    /// their next save. (Wave-3 reviewer finding: don't loosen a security
    /// posture for a feature that doesn't exist yet.)
    private static let accessibility = kSecAttrAccessibleWhenUnlocked

    func save(_ token: String) throws {
        var attributes = baseQuery()
        attributes[kSecValueData as String] = Data(token.utf8)
        attributes[kSecAttrAccessible as String] = Self.accessibility

        let addStatus = SecItemAdd(attributes as CFDictionary, nil)
        switch addStatus {
        case errSecSuccess:
            return
        case errSecDuplicateItem:
            let update: [String: Any] = [
                kSecValueData as String: Data(token.utf8),
                kSecAttrAccessible as String: Self.accessibility,
            ]
            let updateStatus = SecItemUpdate(baseQuery() as CFDictionary, update as CFDictionary)
            guard updateStatus == errSecSuccess else {
                throw KeychainError(operation: "update", status: updateStatus)
            }
        default:
            throw KeychainError(operation: "add", status: addStatus)
        }
    }

    func clear() throws {
        let status = SecItemDelete(baseQuery() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError(operation: "delete", status: status)
        }
    }

    private func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}
