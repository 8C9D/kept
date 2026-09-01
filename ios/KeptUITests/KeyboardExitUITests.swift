import XCTest

/// The first test in this project that executes the confirm screen's
/// keyboard rather than its wiring.
///
/// Everything else about the Done bar is invisible to the unit suite: an
/// accessory view is UIKit, and §10.2's untestable surface is exactly
/// where this defect lived for two attempts. It shipped twice - once with
/// no bar at all, once with a bar 430 points wide and 0 tall - and both
/// looked identical on the device.
///
/// `isHittable` is the assertion that matters, because it is false in
/// both of those states and true only when a person could actually press
/// the button.
///
/// ⚠ What this does not do: run on the OS where the defect was found. CI
/// has a simulator; the defect was on 26.5.2 hardware, and whether the
/// old mechanism installed anything at all varied between sessions on the
/// same build. Green here is a regression guard, not proof - the device
/// matrix in the wave-5 keyboard entry stays manual.
final class KeyboardExitUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    private func launchConfirmScreen(
        extraArguments: [String] = []
    ) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-KeptUITestConfirmScreen"] + extraArguments
        app.launch()
        return app
    }

    private func doneButton(in app: XCUIApplication) -> XCUIElement {
        app.buttons["keyboard.done"]
    }

    /// The bar is a plain view, not a toolbar (KeyboardDoneBar's own doc
    /// comment says why), so it is found by identifier across every
    /// element type rather than through `app.toolbars`.
    private func doneBar(in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: "keyboard.doneBar").firstMatch
    }

    /// Walks the form the way a person does: focusing each money field in
    /// turn scrolls the next one up, which is what eventually brings the
    /// notes field - the only one below the fold - into reach.
    private func focus(_ field: String, in app: XCUIApplication) -> XCUIElement {
        let textField = app.textFields["field.\(field)"].firstMatch
        let target = textField.waitForExistence(timeout: 5)
            ? textField
            : app.textViews["field.\(field)"].firstMatch
        XCTAssertTrue(target.waitForExistence(timeout: 5), "\(field) is not on the confirm screen")
        target.tap()
        return target
    }

    /// The three decimal pads have no return key and notes' return key
    /// inserts a newline, so each of these four must raise a Done button
    /// a person can press.
    func testEveryKeyboardWithNoExitOfItsOwnGetsAPressableDoneButton() {
        let app = launchConfirmScreen()

        for field in ["Total", "HST", "Subtotal", "Notes"] {
            let input = app.textFields["field.\(field)"].firstMatch
            let target = input.exists ? input : app.textViews["field.\(field)"].firstMatch
            XCTAssertTrue(
                target.waitForExistence(timeout: 5),
                "\(field) is not on the confirm screen"
            )
            target.tap()

            let done = doneButton(in: app)
            XCTAssertTrue(
                done.waitForExistence(timeout: 5),
                "\(field) raised a keyboard with no Done button"
            )
            XCTAssertTrue(
                done.isHittable,
                "\(field)'s Done button exists but cannot be pressed - a zero-height or covered bar"
            )
        }
    }

    /// The button must also do its job. A bar that is present, sized and
    /// hittable while Done does nothing is a third failure mode, and the
    /// two device passes could not have told it apart from success.
    func testPressingDoneDismissesTheKeyboard() {
        let app = launchConfirmScreen()

        let total = app.textFields["field.Total"].firstMatch
        XCTAssertTrue(total.waitForExistence(timeout: 5))
        total.tap()

        let done = doneButton(in: app)
        XCTAssertTrue(done.waitForExistence(timeout: 5))
        done.tap()

        let goneAway = NSPredicate(format: "exists == false")
        expectation(for: goneAway, evaluatedWith: done)
        waitForExpectations(timeout: 5)
    }

    /// Typing is a body update, and a body update is when SwiftUI puts its
    /// own empty accessory host back over ours. A bar that only survives
    /// until the first keystroke is the "works most sessions" failure this
    /// whole exercise exists to rule out.
    func testTheBarSurvivesTypingIntoTheField() {
        let app = launchConfirmScreen()

        let total = app.textFields["field.Total"].firstMatch
        XCTAssertTrue(total.waitForExistence(timeout: 5))
        total.tap()
        XCTAssertTrue(doneButton(in: app).waitForExistence(timeout: 5))

        total.typeText("12.34")

        let done = doneButton(in: app)
        XCTAssertTrue(done.exists, "the Done bar was lost while typing")
        XCTAssertTrue(done.isHittable, "the Done bar stopped being pressable while typing")
    }

    /// The single-line text fields dismiss themselves with their return
    /// key, and a bar they do not need costs form height on the screen
    /// that can least afford it (§10A.1). This is the control: it fails if
    /// the rule degrades into "put a bar on everything".
    func testFieldsWhoseReturnKeyAlreadyDismissesGetNoBar() {
        let app = launchConfirmScreen()

        let vendor = app.textFields["field.Vendor"].firstMatch
        XCTAssertTrue(vendor.waitForExistence(timeout: 5))
        vendor.tap()

        XCTAssertFalse(
            doneButton(in: app).waitForExistence(timeout: 2),
            "Vendor's keyboard has a return key and must not also carry a Done bar"
        )
    }

    /// Where the bar sits, not just whether it can be pressed
    /// (2026-09-01). The owner's report was that Done was on the number pad
    /// rather than above it: on iOS 26 a `UIToolbar` serving as an
    /// `inputAccessoryView` paints no background at all and anchors its
    /// item to the bottom of the reserved band, so the Done capsule's
    /// bottom edge landed within a point of the first row of keys, with
    /// the form's own content showing through the band around it.
    ///
    /// The band itself was never in the wrong place - which is exactly why
    /// this needed a frame assertion rather than another `isHittable` one.
    func testTheDoneBarSitsAboveTheKeyboardAndNotOnIt() {
        let app = launchConfirmScreen()

        for field in ["Total", "HST", "Subtotal", "Notes"] {
            _ = focus(field, in: app)
            let bar = doneBar(in: app)
            XCTAssertTrue(bar.waitForExistence(timeout: 5), "\(field) raised no Done bar")
            let keyboard = app.keyboards.element
            XCTAssertTrue(keyboard.waitForExistence(timeout: 5), "\(field) raised no keyboard")

            XCTAssertLessThanOrEqual(
                bar.frame.maxY,
                keyboard.frame.minY,
                "\(field): the Done bar overlaps the keyboard"
            )
            XCTAssertLessThanOrEqual(
                doneButton(in: app).frame.maxY,
                keyboard.frame.minY,
                "\(field): the Done button itself is drawn over the keyboard"
            )

            // And flush, not floating: no dead band between the two. Only
            // asserted for the decimal pads, because `app.keyboards`
            // reports the key plane alone - the alphabetic keyboard's
            // prediction row is a sibling element, so the notes field
            // legitimately measures a bar's height of daylight that is not
            // daylight at all.
            if field != "Notes" {
                XCTAssertLessThan(
                    keyboard.frame.minY - bar.frame.maxY,
                    bar.frame.height,
                    "\(field): the Done bar floats a whole bar's height above the pad"
                )
            }
        }
    }

    /// The negative control (verification item 2). Launched with the bar
    /// deliberately collapsed to zero height - the exact shape that read
    /// as success on the device - the assertions above must fail. A check
    /// that has never been seen to fail is not evidence.
    func testTheCheckItselfFailsWhenTheBarIsCollapsed() {
        let app = launchConfirmScreen(extraArguments: ["-KeptZeroHeightDoneBar"])

        let total = app.textFields["field.Total"].firstMatch
        XCTAssertTrue(total.waitForExistence(timeout: 5))
        total.tap()

        let done = doneButton(in: app)
        let reachable = done.waitForExistence(timeout: 3) && done.isHittable
        XCTAssertFalse(
            reachable,
            "A zero-height bar was reported as pressable - the check cannot tell the two apart"
        )
    }
}
