import XCTest

/// The three free-text rows on the confirm screen - vendor, category,
/// payment method - executed rather than reasoned about.
///
/// They exist because of a defect the unit suite cannot see and the value
/// assertions below only half-catch: a trailing-aligned SwiftUI
/// `TextField` does not render a space that is currently the last
/// character. Typing "Food Basics" showed "Food" until the "B" arrived, so
/// the space read as a keystroke the app had swallowed - on a form whose
/// whole job is typing a shop's name.
///
/// ⚠ What these assert is that the character reaches the string, which was
/// always true and stayed true through the defect. The rendering half was
/// established by screenshot: two shots taken either side of the space
/// were byte-identical before the fix (leading alignment) and differ
/// after. Green here is the input guard; the pixels stay a manual check.
final class FreeTextFieldUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    private func launchConfirmScreen() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-KeptUITestConfirmScreen"]
        app.launch()
        return app
    }

    /// Clears whatever the parser prefilled, one keystroke at a time. A
    /// select-all through the edit menu depends on a long-press landing on
    /// a menu item whose wording is not ours; backspaces depend on
    /// nothing.
    private func clear(_ field: XCUIElement) {
        let existing = (field.value as? String) ?? ""
        guard !existing.isEmpty else { return }
        field.typeText(
            String(repeating: XCUIKeyboardKey.delete.rawValue, count: existing.count)
        )
    }

    /// Both rows this walks to sit below the fold on a 6.3-inch screen,
    /// and a Form is a collection view - a row that has never been on
    /// screen does not exist to be tapped.
    private func scrollTo(_ identifier: String, in app: XCUIApplication) -> XCUIElement {
        let element = app.textFields[identifier].firstMatch
        for _ in 0..<4 {
            if element.exists && element.isHittable { return element }
            app.swipeUp()
        }
        return element
    }

    func testASpaceTypedIntoVendorSurvivesIntoTheField() {
        let app = launchConfirmScreen()
        let vendor = app.textFields["field.Vendor"].firstMatch
        XCTAssertTrue(vendor.waitForExistence(timeout: 5))
        vendor.tap()
        clear(vendor)

        vendor.typeText("Food")
        XCTAssertEqual(vendor.value as? String, "Food")
        // The keystroke the bug was reported as losing. It is in the
        // string here and always was - which is what makes "Food" still
        // being on screen at this point a layout bug and not an input one.
        vendor.typeText(" ")
        XCTAssertEqual(vendor.value as? String, "Food ")
        vendor.typeText("Basics")
        XCTAssertEqual(vendor.value as? String, "Food Basics")
    }

    /// Category and payment method are the same row type as vendor
    /// (ReusableValueFieldRow), which is the point: the fix is one
    /// alignment on one struct, so a regression on any of the three is a
    /// regression on all three. Asserted per field anyway, because "they
    /// share a struct" is exactly the assumption that stops being true.
    func testASpaceTypedIntoCategoryAndPaymentSurvivesIntoTheField() {
        let app = launchConfirmScreen()

        for field in ["Category", "Payment"] {
            let row = scrollTo("field.\(field)", in: app)
            XCTAssertTrue(row.exists, "\(field) is not on the confirm screen")
            row.tap()
            clear(row)
            row.typeText("Office supplies")
            XCTAssertEqual(
                row.value as? String,
                "Office supplies",
                "\(field) lost the space"
            )
        }
    }
}
