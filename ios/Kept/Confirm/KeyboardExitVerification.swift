#if DEBUG
import OSLog
import UIKit

/// The acceptance check for the Done bar, and the deliberate break that
/// proves the check can fail.
///
/// This exists because the defect it guards is invisible to every other
/// instrument available. The unit suite cannot execute an accessory view
/// (§10.2), and on the device a bar that is absent and a bar that is 430
/// points wide by 0 tall look exactly alike - the second is what the
/// investigation actually found on one of three runs. So the pass
/// criterion is asserted, not eyeballed: installed, on screen, non-zero
/// height, visible, and the Done control genuinely hit-testable through
/// whatever is above it.
///
/// Compiled out of shipped builds entirely.
@MainActor
enum KeyboardExitVerification {
    private static let log = Logger(subsystem: "com.arthurzhang.kept", category: "keyboardexit")

    /// The negative control. Launch with `-KeptZeroHeightDoneBar` and the
    /// bar installs collapsed - the exact shape that read as success on
    /// the device - and `check` must report FAIL. A verification that has
    /// never been seen to fail is not evidence of anything.
    static var barHeightOverride: CGFloat? {
        ProcessInfo.processInfo.arguments.contains("-KeptZeroHeightDoneBar") ? 0 : nil
    }

    /// Runs after the keyboard and its accessory have settled - reading
    /// the frame inside `textDidBeginEditing` would measure a bar that has
    /// not been laid out yet, which is its own false negative.
    static func check(bar: UIView, on input: UIView) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
            MainActor.assumeIsolated { report(bar: bar, on: input) }
        }
    }

    private static func report(bar: UIView, on input: UIView) {
        var failures: [String] = []
        var notes: [String] = []

        // The invariant is "whatever is on screen for this field is our
        // bar", not "the property still points at it at an arbitrary
        // instant". SwiftUI overwrites the property on every body update
        // and there is no stopping it; what matters is that the bar the
        // person can see and press is ours, and that the property is
        // restored before UIKit next queries it - which the responder- and
        // text-change hooks do. The clobber is still recorded, because a
        // fact this fix depends on should not be invisible.
        if bar.window == nil {
            failures.append("bar is not on screen")
        }
        if input.inputAccessoryView !== bar {
            notes.append("property clobbered since install (re-asserted on next input event)")
        }
        if bar.frame.height <= 0 {
            failures.append("bar height is \(bar.frame.height)")
        }
        if bar.isHidden {
            failures.append("bar is hidden")
        }
        if bar.alpha <= 0 {
            failures.append("bar alpha is \(bar.alpha)")
        }

        // The one the eye cannot check: a bar can be present, sized and
        // visible while something above it takes the touch.
        if let done = bar.firstDescendant(identified: KeyboardExitIdentifiers.doneButton) {
            if let host = done.window {
                let centre = done.convert(
                    CGPoint(x: done.bounds.midX, y: done.bounds.midY), to: host
                )
                let hit = host.hitTest(centre, with: nil)
                let reachesDone = hit === done || hit?.isDescendant(of: done) == true
                if !reachesDone {
                    failures.append(
                        "Done is not hit-testable - \(centre) hits \(hit.map { "\(type(of: $0))" } ?? "nothing")"
                    )
                }
            } else {
                failures.append("Done control is not in a window")
            }
        } else {
            failures.append("no control carrying \(KeyboardExitIdentifiers.doneButton)")
        }

        let verdict = failures.isEmpty ? "PASS" : "FAIL"
        let detail = failures.isEmpty ? "bar=\(bar.frame)" : failures.joined(separator: "; ")
        let trailing = notes.isEmpty ? "" : " [\(notes.joined(separator: "; "))]"
        emit("\(verdict) \(type(of: input)) keyboard=\(keyboardName(of: input)) \(detail)\(trailing)")
    }

    private static func keyboardName(of input: UIView) -> String {
        guard let field = input as? UITextField else { return "textView" }
        return field.keyboardType == .decimalPad ? "decimalPad" : "\(field.keyboardType.rawValue)"
    }

    /// Two sinks: the unified log for Console.app, stdout for a
    /// `devicectl ... --console` launch.
    private static func emit(_ line: String) {
        log.log("\(line, privacy: .public)")
        print("[keyboardexit] \(line)")
    }
}

private extension UIView {
    /// A toolbar renders its items as private control subclasses, so the
    /// identifier set on the `UIBarButtonItem` is what finds the button.
    func firstDescendant(identified identifier: String) -> UIView? {
        if accessibilityIdentifier == identifier { return self }
        for subview in subviews {
            if let found = subview.firstDescendant(identified: identifier) { return found }
        }
        return nil
    }
}
#endif
