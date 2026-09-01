import XCTest

/// The total-tracking rule (2026-09-01) executed on the real form rather
/// than reasoned about on the model.
///
/// The unit suite already pins `editComponentAmount` in every direction
/// (ConfirmFormTotalTrackingTests). What it cannot see is the wiring the
/// whole rule depends on: the four component money rows are bound through
/// `componentBinding`, not to their own text properties, and a row left on
/// the plain binding would type perfectly normally, pass every unit test,
/// and silently never move the total. That is a defect only a keystroke
/// through a real `TextField` can catch.
///
/// ⚠ Two mechanics this file has to know about, both established by
/// running it rather than by reading anything:
///
/// - **Where the caret lands.** The five money rows are trailing-aligned
///   (digits line up on the decimal point), and a centre tap on one puts
///   the caret at position 0 - so backspaces delete nothing and the field
///   never clears. They are tapped near their right edge instead. The
///   total card's field is the leading-aligned exception and takes an
///   ordinary tap, which lands the caret after the digits.
/// - **Where the keyboard is.** `isHittable` stays true for a row sitting
///   underneath the keyboard, and a tap there focuses nothing
///   ("Failed to synthesize event: Neither element nor any descendant has
///   keyboard focus"). Every interaction below therefore scrolls the form
///   back to the top first - which also dismisses the keyboard, through
///   the Form's own `.scrollDismissesKeyboard(.immediately)` - and then
///   brings the target into the upper part of the screen.
final class ConfirmAmountsUITests: XCTestCase {
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

    /// Puts the keyboard away, brings `label`'s row into the top of the
    /// screen, and focuses it with the caret after its last character.
    @discardableResult
    private func focus(_ label: String, in app: XCUIApplication) -> XCUIElement {
        let element = app.textFields["field.\(label)"].firstMatch
        // Converge on a band that is below the navigation bar and above
        // the keyboard, from whichever side the row currently sits on.
        // Both edges are needed: a row under the keyboard swallows the
        // tap, and a row under the navigation bar does too.
        let top = app.frame.height * 0.12
        let bottom = app.frame.height * 0.45
        for _ in 0..<8 {
            guard element.exists else {
                app.swipeUp()
                continue
            }
            let frame = element.frame
            if frame.minY > top, frame.maxY < bottom { break }
            if frame.minY <= top {
                app.swipeDown()
            } else {
                app.swipeUp()
            }
        }
        if label == "Total" {
            element.tap()
        } else {
            element.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.5)).tap()
        }
        return element
    }

    /// Empties the row and types `text` into it - backspaces rather than a
    /// select-all, because the edit menu's wording is not ours to depend
    /// on (FreeTextFieldUITests makes the same call).
    ///
    /// Focusing is verified by its EFFECT rather than by asking: a tap
    /// that scrolled the Form instead of landing in the field leaves the
    /// value untouched, so an unchanged box means "try again" rather than
    /// "the app is broken". Three attempts, then the assertion speaks.
    private func replace(_ label: String, with text: String, in app: XCUIApplication) {
        for _ in 0..<3 {
            let field = focus(label, in: app)
            let existing = (field.value as? String) ?? ""
            if existing.isEmpty { break }
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: existing.count))
            if value(label, in: app).isEmpty { break }
        }
        XCTAssertEqual(value(label, in: app), "", "\(label) did not clear")
        if !text.isEmpty {
            app.textFields["field.\(label)"].firstMatch.typeText(text)
        }
    }

    private func value(_ label: String, in app: XCUIApplication) -> String {
        (app.textFields["field.\(label)"].firstMatch.value as? String) ?? ""
    }

    /// **Flow B**: a blank form - a photograph the parsers got nothing
    /// from - where the subtotal and the HST are typed and the total is
    /// never touched at all. Then **flow C** (a corrected component moves
    /// a total that still agrees with it) and **flow D** (a total typed by
    /// hand is the anchor, and nothing later overwrites it) on the same
    /// form, because all three are the same rule seen from three angles.
    ///
    /// The harness opens on a consistent 10.92 / 1.42 / 12.34, so reaching
    /// a blank form is part of the test - and the order matters: the
    /// subtotal goes first, because with no subtotal the rule has no sum
    /// to track to and stops recomputing on the way down.
    func testTheTotalTracksItsComponentsThroughRealKeystrokes() {
        let app = launchConfirmScreen()
        XCTAssertTrue(app.textFields["field.Subtotal"].firstMatch.waitForExistence(timeout: 5))

        replace("Subtotal", with: "", in: app)
        replace("HST", with: "", in: app)
        replace("Total", with: "", in: app)
        XCTAssertEqual(value("Total", in: app), "")

        // Flow B: four boxes become one running bill.
        replace("Subtotal", with: "12.70", in: app)
        XCTAssertEqual(value("Total", in: app), "12.70")
        replace("HST", with: "1.65", in: app)
        XCTAssertEqual(value("Total", in: app), "14.35")

        // Flow C: leaving 14.35 after the HST is corrected would create a
        // mismatch nobody asked for.
        replace("HST", with: "1.60", in: app)
        XCTAssertEqual(value("Total", in: app), "14.30")

        // Flow D: 20.00 is not what the components say, so the total is
        // now the person's own number and a later subtotal edit leaves it
        // alone.
        replace("Total", with: "20.00", in: app)
        replace("Subtotal", with: "13.00", in: app)
        XCTAssertEqual(value("Total", in: app), "20.00")
    }
}
