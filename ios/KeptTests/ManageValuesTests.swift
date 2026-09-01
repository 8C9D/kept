import XCTest
@testable import Kept

/// The manage-values screen's rules and the two calls behind it
/// (2026-09-01). The rules are the same ones the web client's
/// `manageValues.ts` carries, and are tested here for the same reason they
/// are tested there: they are wording and arithmetic about someone's tax
/// records, and a screen is a bad place to keep either.
@MainActor
final class ManageValuesRulesTests: XCTestCase {
    func testATypedTargetIsTrimmed() {
        let validation = ManageValuesRules.validateRename(
            from: "Loblwas",
            to: "  Loblaws  ",
            existing: ["Loblwas"]
        )
        XCTAssertEqual(validation, .ready(to: "Loblaws", merges: false))
    }

    /// The value being renamed FROM is matched exactly and never trimmed -
    /// which is what keeps a stray-space value reachable, distinct, and
    /// renameable. Fixing exactly that is one of the things this screen is
    /// for.
    func testAStraySpaceValueIsItselfRenameable() {
        let validation = ManageValuesRules.validateRename(
            from: "Food Basics ",
            to: "Food Basics",
            existing: ["Food Basics ", "Food Basics"]
        )
        XCTAssertEqual(validation, .ready(to: "Food Basics", merges: true))
    }

    /// Clearing the box abandons the rename. It is emphatically NOT a
    /// delete - that would be the most destructive possible reading of an
    /// empty input.
    func testABlankTargetIsNeverADelete() {
        XCTAssertEqual(
            ManageValuesRules.validateRename(from: "Loblaws", to: "   ", existing: []),
            .blank
        )
    }

    func testRenamingAValueToItselfIsNothingToSend() {
        XCTAssertEqual(
            ManageValuesRules.validateRename(from: "Loblaws", to: "Loblaws", existing: ["Loblaws"]),
            .unchanged
        )
    }

    func testAMergeIsFlaggedWhenTheTargetAlreadyExists() {
        let validation = ManageValuesRules.validateRename(
            from: "Food basics",
            to: "Food Basics",
            existing: ["Food basics", "Food Basics"]
        )
        XCTAssertEqual(validation, .ready(to: "Food Basics", merges: true))
    }

    /// "12 receipts updated" and "0" are different events and the person
    /// just caused one of them.
    func testTheRenameResultCountsReceiptsInWords() {
        XCTAssertEqual(
            ManageValuesRules.renameResultMessage(from: "A", to: "B", receiptsUpdated: 0),
            "Renamed “A” to “B”. No receipts carried it."
        )
        XCTAssertEqual(
            ManageValuesRules.renameResultMessage(from: "A", to: "B", receiptsUpdated: 1),
            "Renamed “A” to “B”. 1 receipt updated."
        )
        XCTAssertEqual(
            ManageValuesRules.renameResultMessage(from: "A", to: "B", receiptsUpdated: 12),
            "Renamed “A” to “B”. 12 receipts updated."
        )
    }

    /// The confirmation states what survives in the same breath as what
    /// goes. A person reading "remove this value?" alone would reasonably
    /// hear "erase it from my records", which is the one thing it does
    /// not do.
    func testTheDeleteConfirmationSaysTheReceiptsKeepTheirText() {
        let text = ManageValuesRules.deleteConfirmation(field: .paymentMethod, value: "Visa")
        XCTAssertTrue(text.contains("payment method list"), text)
        XCTAssertTrue(text.contains("keep the text"), text)
        XCTAssertTrue(text.contains("only the suggestion goes"), text)
    }
}

/// The model's two calls, and the refresh every change is followed by.
@MainActor
final class ManageValuesModelTests: XCTestCase {
    private var api: StubKeptAPI!
    private var options: ReceiptOptionsStore!
    private var defaults: UserDefaults!

    override func setUp() async throws {
        try await super.setUp()
        api = StubKeptAPI()
        defaults = UserDefaults(suiteName: "ManageValuesModelTests-\(UUID().uuidString)")
        options = ReceiptOptionsStore(api: api, defaults: defaults)
        api.receiptOptionsHandler = {
            ReceiptOptions(categories: ["meals"], paymentMethods: ["Visa"], vendors: ["Loblaws"])
        }
    }

    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: defaults.description)
        try await super.tearDown()
    }

    func testRenameSendsTheFieldAndBothValuesAndReportsTheCount() async {
        api.renameReceiptOptionHandler = { _, _, _ in 12 }
        let model = ManageValuesModel(api: api, options: options)

        await model.rename(field: .vendor, from: "Loblwas", to: "Loblaws")

        XCTAssertEqual(api.renameReceiptOptionCalls.count, 1)
        XCTAssertEqual(api.renameReceiptOptionCalls[0].field, .vendor)
        XCTAssertEqual(api.renameReceiptOptionCalls[0].from, "Loblwas")
        XCTAssertEqual(api.renameReceiptOptionCalls[0].to, "Loblaws")
        XCTAssertEqual(model.notice, "Renamed “Loblwas” to “Loblaws”. 12 receipts updated.")
        XCTAssertNil(model.errorMessage)
        // Unconditional: a rename can remove a list entry (a merge), add
        // one, and reorder the rest, none of which is predictable here.
        XCTAssertEqual(api.receiptOptionsCalls, 1)
    }

    func testDeleteSendsTheFieldAndValueAndSaysTheReceiptsKeepIt() async {
        let model = ManageValuesModel(api: api, options: options)

        await model.delete(field: .category, value: "grocries")

        XCTAssertEqual(api.deleteReceiptOptionCalls.count, 1)
        XCTAssertEqual(api.deleteReceiptOptionCalls[0].field, .category)
        XCTAssertEqual(api.deleteReceiptOptionCalls[0].value, "grocries")
        XCTAssertEqual(
            model.notice,
            "Removed “grocries” from the list. Receipts that used it still say so."
        )
        XCTAssertEqual(api.receiptOptionsCalls, 1)
    }

    /// The server's own words, verbatim - most pointedly the 404 for a
    /// value that is not one of this person's.
    func testAFailedRenameSurfacesTheServersMessageAndRefreshesNothing() async {
        api.renameReceiptOptionHandler = { _, _, _ in
            throw APIError.requestFailed(code: "not_found", message: "Receipt not found", status: 404)
        }
        let model = ManageValuesModel(api: api, options: options)

        await model.rename(field: .vendor, from: "Nope", to: "Something")

        XCTAssertEqual(model.errorMessage, "Receipt not found")
        XCTAssertNil(model.notice)
        XCTAssertEqual(api.receiptOptionsCalls, 0, "nothing changed, so nothing to re-read")
    }

    func testAFailedDeleteSurfacesTheServersMessage() async {
        api.deleteReceiptOptionHandler = { _, _ in
            throw APIError.requestFailed(code: "not_found", message: "Receipt not found", status: 404)
        }
        let model = ManageValuesModel(api: api, options: options)

        await model.delete(field: .paymentMethod, value: "Nope")

        XCTAssertEqual(model.errorMessage, "Receipt not found")
        XCTAssertNil(model.notice)
    }
}

/// The confirm form's past-values control, which stopped being able to be
/// a menu when the options route's 100-value cap went away (2026-09-01).
final class PastValuesPresentationTests: XCTestCase {
    func testATwelveValueListStaysAMenu() {
        XCTAssertFalse(PastValuesPresentation.usesSearchSheet(valueCount: 12))
        XCTAssertFalse(PastValuesPresentation.usesSearchSheet(valueCount: 0))
        XCTAssertEqual(PastValuesPresentation.menuLimit, 12)
    }

    func testThirteenOrMoreBecomesTheSearchableSheet() {
        XCTAssertTrue(PastValuesPresentation.usesSearchSheet(valueCount: 13))
        XCTAssertTrue(PastValuesPresentation.usesSearchSheet(valueCount: 400))
    }

    /// Substring, not prefix: "basics" has to find "Food Basics", because
    /// that is how a person searches a list of shops they already know.
    func testTheFilterMatchesAnywhereInTheValueAndIgnoresCase() {
        let values = ["Food Basics", "FreshCo", "Loblaws"]
        XCTAssertEqual(PastValuesPresentation.filter(values, query: "basics"), ["Food Basics"])
        XCTAssertEqual(PastValuesPresentation.filter(values, query: "O"), values)
    }

    func testTheFilterKeepsTheServersOrderWhichIsMostRecentFirst() {
        let values = ["Loblaws", "Food Basics", "Longos"]
        XCTAssertEqual(
            PastValuesPresentation.filter(values, query: "lo"),
            ["Loblaws", "Longos"]
        )
    }

    /// An untouched search field means "everything", including one holding
    /// only spaces.
    func testABlankQueryMatchesEverything() {
        let values = ["Loblaws", "FreshCo"]
        XCTAssertEqual(PastValuesPresentation.filter(values, query: ""), values)
        XCTAssertEqual(PastValuesPresentation.filter(values, query: "   "), values)
    }

    func testNoMatchIsAnEmptyListNotEverything() {
        XCTAssertTrue(PastValuesPresentation.filter(["Loblaws"], query: "zzz").isEmpty)
    }
}
