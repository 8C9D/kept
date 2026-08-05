import Foundation
@testable import Kept

/// A SessionTokenStore that is just a variable, plus injectable failures
/// for exercising the error paths a real keychain rarely produces on
/// demand.
final class InMemoryTokenStore: SessionTokenStore {
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
