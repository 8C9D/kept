import Foundation
@testable import Kept

/// A SessionTokenStore that is just a variable, plus injectable failures
/// for exercising the error paths a real keychain rarely produces on
/// demand.
///
/// @unchecked Sendable rather than @MainActor because the protocol's
/// load() is synchronous - a main-actor witness cannot satisfy it. Tests
/// configure the store before use and the code under test reads it from
/// one task at a time, so the unprotected vars are safe in practice.
final class InMemoryTokenStore: SessionTokenStore, @unchecked Sendable {
    var stored: String?

    var loadError: Error?
    var saveError: Error?
    var clearError: Error?

    init(stored: String? = nil) {
        self.stored = stored
    }

    func load() throws -> String? {
        if let loadError { throw loadError }
        return stored
    }

    func save(_ token: String) throws {
        if let saveError { throw saveError }
        stored = token
    }

    func clear() throws {
        if let clearError { throw clearError }
        stored = nil
    }
}
