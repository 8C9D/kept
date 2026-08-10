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
    /// `barWasOnScreen` is read at install time, before the bar is
    /// re-presented, and is the cold-versus-warm discriminator: on a cold
    /// focus nothing is up, so the bar is in no window; on a field-to-field
    /// move with the keyboard already raised, the previous field's bar is
    /// still on screen. Printed so a warm move is evidenced by the log
    /// rather than attested to from memory.
    static func check(input: UIView, expectsBar: Bool, bar: UIView?, barWasOnScreen: Bool) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
            MainActor.assumeIsolated {
                report(
                    input: input, expectsBar: expectsBar, bar: bar, barWasOnScreen: barWasOnScreen
                )
            }
        }
    }

    private static func report(input: UIView, expectsBar: Bool, bar: UIView?, barWasOnScreen: Bool) {
        let entry = barWasOnScreen ? "warm" : "cold"
        let prefix = "entry=\(entry) \(type(of: input)) keyboard=\(keyboardName(of: input))"

        // The negative case, and the reason every focus reports: this
        // field's return key already dismisses, so a bar here would be the
        // "a bar on everything" failure - and it has to be legible, not
        // inferred from the absence of a line.
        guard expectsBar else {
            let carriesOurBar = bar != nil && input.inputAccessoryView === bar
            emit(
                carriesOurBar
                    ? "FAIL \(prefix) a Done bar was installed on a field whose return key dismisses"
                    : "PASS \(prefix) no bar, as intended - this keyboard has its own return key"
            )
            return
        }

        guard let bar else {
            emit("FAIL \(prefix) no bar was ever built for a keyboard with no exit of its own")
            return
        }

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
        //
        // Found by walking for a `UIControl` rather than by accessibility
        // identifier. `UIBarButtonItem`'s identifier reaches the view layer
        // through accessibility, which is live under XCUITest and not in a
        // plain device run - so the identifier lookup reported "no control"
        // on device for a bar that was demonstrably on screen. The toolbar
        // carries one control: the Done item; the flexible space has no view.
        if let done = bar.firstControlDescendant {
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
            failures.append("the bar contains no UIControl at all")
        }

        let verdict = failures.isEmpty ? "PASS" : "FAIL"
        let detail = failures.isEmpty ? "bar=\(bar.frame)" : failures.joined(separator: "; ")
        let trailing = notes.isEmpty ? "" : " [\(notes.joined(separator: "; "))]"
        emit("\(verdict) \(prefix) \(detail)\(trailing)")
    }

    private static func keyboardName(of input: UIView) -> String {
        guard let field = input as? UITextField else { return "textView" }
        return field.keyboardType == .decimalPad ? "decimalPad" : "\(field.keyboardType.rawValue)"
    }

    /// Three sinks: the unified log for Console.app, stdout for a
    /// `devicectl ... --console` launch, and a file in the app's Documents
    /// directory.
    ///
    /// The file is there for the background round trip. Backgrounding has
    /// killed the console every time it has been tried, once by SIGKILL,
    /// so the one state whose evidence is most likely to be lost is the one
    /// that most needs a sink that outlives the process.
    private static func emit(_ line: String) {
        log.log("\(line, privacy: .public)")
        print("[keyboardexit] \(line)")
        appendToFile(line)
    }

    private static let logFileURL: URL? = FileManager.default
        .urls(for: .documentDirectory, in: .userDomainMask).first?
        .appendingPathComponent("keyboard-exit.log")

    private static func appendToFile(_ line: String) {
        guard let url = logFileURL else {
            print("[keyboardexit] file sink unavailable: no documents directory")
            return
        }
        // The pid is the point: if iOS kills the app while it is
        // backgrounded, reopening it is a cold launch wearing a resume's
        // clothes, and the round trip was never actually exercised. A
        // changed pid says so.
        let stamped = "\(Date().timeIntervalSince1970) pid=\(ProcessInfo.processInfo.processIdentifier) \(line)\n"
        do {
            if !FileManager.default.fileExists(atPath: url.path) {
                try Data().write(to: url)
            }
            let handle = try FileHandle(forWritingTo: url)
            defer { try? handle.close() }
            try handle.seekToEnd()
            try handle.write(contentsOf: Data(stamped.utf8))
        } catch {
            // Loudly, on the sinks that still work - a diagnostic that
            // fails quietly is worse than none.
            print("[keyboardexit] file sink write failed: \(error)")
            log.log("file sink write failed: \(String(describing: error), privacy: .public)")
        }
    }
}

private extension UIView {
    /// A toolbar renders its items as private `UIControl` subclasses.
    var firstControlDescendant: UIControl? {
        if let control = self as? UIControl { return control }
        for subview in subviews {
            if let found = subview.firstControlDescendant { return found }
        }
        return nil
    }
}
#endif
