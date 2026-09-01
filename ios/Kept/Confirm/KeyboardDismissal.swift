import SwiftUI
import UIKit

/// The confirm screen's two UIKit keyboard exits (§10A.1): a Done button
/// on every keyboard that cannot close itself, and a tap anywhere that is
/// not a text field. The third exit, dismiss-on-scroll, is a SwiftUI
/// modifier on the Form and stays there.
///
/// Both live in UIKit because SwiftUI cannot express either one here.
///
/// **The tap.** A `TapGesture` on the Form races the tapped `TextField`'s
/// own focus: moving from one money field to the next would sometimes
/// dismiss the keyboard instead of moving, and a tap inside the focused
/// field to reposition the cursor would close it outright. A gesture
/// recognizer can be asked, per touch, whether that touch landed on a
/// text input, and stand down when it did - which is the actual rule.
///
/// **The Done button.** `ToolbarItemGroup(placement: .keyboard)` installs
/// nothing at all through this screen's presentation. Proven on device
/// three ways over fifteen focus events: no `inputAccessoryView`, no
/// `inputAccessoryViewController`, and no host view anywhere in the
/// `UITextEffectsWindow` - whose container heights were bare keyboard
/// heights with nothing added. Whether it installs even an empty
/// zero-height host is not deterministic across sessions. The first
/// responder is the one thing that held in every observation, so the bar
/// is hung on it directly rather than requested from the toolbar system.
///
/// Neither exit swallows anything (`cancelsTouchesInView = false`), so
/// every row, button and field behaves exactly as it did before; both end
/// in the same `endEditing` call, and SwiftUI's `@FocusState` follows the
/// resigned responder back to nil on its own.
///
/// Place it as a background: it draws nothing and takes no touches itself,
/// it is only there to find the window and to leave with the screen.
struct ProvidesKeyboardExits: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> UIView {
        let view = WindowObservingView()
        view.isUserInteractionEnabled = false
        // didMoveToWindow rather than updateUIView: the window is the
        // thing being waited for, and an update is not guaranteed to
        // arrive after the view lands in one.
        view.onMoveToWindow = { [weak coordinator = context.coordinator] window in
            coordinator?.attach(to: window)
        }
        return view
    }

    func updateUIView(_ view: UIView, context: Context) {}

    /// Detaches when the confirm screen goes away: the view leaves the
    /// window, `didMoveToWindow` fires with nil, and the recognizer and
    /// the focus observers come off with it. Nothing is left on the
    /// window, or on the notification centre, for other screens.
    final class WindowObservingView: UIView {
        var onMoveToWindow: ((UIWindow?) -> Void)?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            onMoveToWindow?(window)
        }
    }

    @MainActor
    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        private weak var window: UIWindow?
        private var recognizer: UITapGestureRecognizer?
        /// One bar for the screen's life, held strongly: it has to be
        /// recognisable when SwiftUI puts its own empty host back, and
        /// re-presenting a fresh bar on every keystroke would flicker.
        private var doneBar: KeyboardDoneBar?
        /// Which field the bar is currently presented for; a responder
        /// change is the one moment UIKit re-queries on its own.
        private weak var barPresentedFor: UIView?

        func attach(to window: UIWindow?) {
            guard window !== self.window else { return }
            detach()
            guard let window else { return }
            let tap = UITapGestureRecognizer(target: self, action: #selector(dismissKeyboard))
            tap.cancelsTouchesInView = false
            tap.delegate = self
            window.addGestureRecognizer(tap)
            self.window = window
            recognizer = tap
            // Begin-editing installs it; the change notifications re-assert
            // it, because SwiftUI overwrites the property on body updates
            // and those are what a body update follows.
            for name in [
                UITextField.textDidBeginEditingNotification,
                UITextView.textDidBeginEditingNotification,
            ] {
                NotificationCenter.default.addObserver(
                    self, selector: #selector(textDidBeginEditing), name: name, object: nil
                )
            }
            for name in [
                UITextField.textDidChangeNotification,
                UITextView.textDidChangeNotification,
            ] {
                NotificationCenter.default.addObserver(
                    self, selector: #selector(textDidChange), name: name, object: nil
                )
            }
            // A keyboard frame change - rotation, a hardware keyboard
            // appearing - is the other moment UIKit re-queries without a
            // text event to hang the re-assertion on.
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(keyboardFrameChanged),
                name: UIResponder.keyboardWillChangeFrameNotification,
                object: nil
            )
        }

        private func detach() {
            if let recognizer {
                window?.removeGestureRecognizer(recognizer)
            }
            recognizer = nil
            window = nil
            doneBar = nil
            barPresentedFor = nil
            NotificationCenter.default.removeObserver(self)
        }

        @objc private func dismissKeyboard() {
            window?.endEditing(true)
        }

        // MARK: - The Done bar

        /// Hung at begin-editing rather than built into the field: a Form
        /// is a collection view, so the fields below the fold do not exist
        /// to be prepared in advance. The `window` check keeps this to the
        /// screen that asked for it - the observers are global, the rule
        /// is not.
        @objc private func textDidBeginEditing(_ notification: Notification) {
            guard let input = notification.object as? UIView, input.window === window else { return }
            let expectsBar = input.keyboardHasNoExitOfItsOwn
            // Read before anything moves: on a cold focus no bar is up, on
            // a field-to-field move the previous field's bar still is.
            let barWasOnScreen = doneBar?.window != nil
            if expectsBar {
                ensureDoneBar(on: input)
                // SwiftUI overwrites the property during the body update
                // this notification precedes, so the same assertion is made
                // again once that update has run.
                DispatchQueue.main.async { [weak self] in
                    MainActor.assumeIsolated { self?.ensureDoneBar(on: input) }
                }
            }
            #if DEBUG
            // Every focus reports, including the fields that must *not* get
            // a bar. A field with no bar previously produced no line at
            // all, which is indistinguishable from a field nobody tapped -
            // so the control against "a bar on everything" was unreadable.
            KeyboardExitVerification.check(
                input: input, expectsBar: expectsBar, bar: doneBar, barWasOnScreen: barWasOnScreen
            )
            #endif
        }

        @objc private func textDidChange(_ notification: Notification) {
            guard let input = notification.object as? UIView,
                  input.window === window,
                  input.keyboardHasNoExitOfItsOwn
            else { return }
            ensureDoneBar(on: input)
        }

        @objc private func keyboardFrameChanged() {
            guard let input = barPresentedFor, input.isFirstResponder else { return }
            ensureDoneBar(on: input)
        }

        /// Self-healing rather than install-once. SwiftUI puts its own
        /// empty zero-size `RootUIView` back into `inputAccessoryView` on
        /// every body update, whether or not a keyboard toolbar is
        /// declared - so "the field already has an accessory view" is
        /// always true and says nothing, and an install that is not
        /// re-asserted survives only until UIKit next re-queries. That
        /// collapsed host is also exactly what the device kept mistaking
        /// for a Done bar.
        private func ensureDoneBar(on input: UIView) {
            let bar = doneBar ?? makeDoneBar()
            doneBar = bar
            guard input.inputAccessoryView !== bar else { return }
            switch input {
            case let field as UITextField:
                field.inputAccessoryView = bar
            case let textView as UITextView:
                textView.inputAccessoryView = bar
            default:
                return
            }
            // Re-present when the bar is showing for a different field, or
            // is not on screen at all. Skipping the reload for the field
            // already showing it is what keeps a keystroke - which is also
            // a body update, and so also a clobber - from flickering the
            // keyboard.
            if barPresentedFor !== input || bar.window == nil {
                barPresentedFor = input
                input.reloadInputViews()
            }
        }

        private func makeDoneBar() -> KeyboardDoneBar {
            // An explicit height, never `sizeToFit`: a zero-height bar is
            // indistinguishable from no bar at all on the device, and that
            // is precisely the failure this replaces.
            var height: CGFloat = KeyboardDoneBar.standardHeight
            #if DEBUG
            height = KeyboardExitVerification.barHeightOverride ?? height
            #endif
            return KeyboardDoneBar(
                width: window?.bounds.width ?? 0,
                height: height,
                target: self,
                action: #selector(dismissKeyboard)
            )
        }

        // MARK: - The tap

        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldReceive touch: UITouch
        ) -> Bool {
            // A tap on a text input is never "outside": on the focused
            // field it is the person moving the cursor, and on any other
            // field it is that field about to take focus for itself.
            !(touch.view?.isInsideTextInput ?? false)
        }
    }
}

/// The bar itself: a plain view we lay out, not a `UIToolbar`.
///
/// **Why it stopped being a toolbar (2026-09-01).** UIKit reserved the 44
/// points correctly and always had - measured on iOS 26.3, the band sat at
/// y 522-566 with the keyboard's own top edge at 566.5, flush. What iOS 26
/// does not do is *paint* a toolbar that is serving as an
/// `inputAccessoryView`: a `UIToolbarAppearance` with
/// `configureWithOpaqueBackground()` and an explicit `backgroundColor`
/// leaves not one pixel of that colour on screen (checked by sampling the
/// band in a simulator screenshot). All that renders is the bar button
/// item, drawn as a tinted capsule anchored to the band's *bottom* edge -
/// so its bottom landed at 565.7 with the keys starting at 566.5, glow
/// spilling onto the pad, and the form's own content showing through the
/// transparent band above it. From the thumb's point of view that is a
/// Done button sitting on the number pad, which is what it was reported as.
///
/// A view we own has neither problem: the background is ours to draw, so
/// the band reads as a bar rather than as a hole onto the form, and the
/// button is inset inside it, so it cannot touch the keys. Everything the
/// 2026-08-09 decision established is unchanged - the bar is still hung on
/// the first responder rather than requested from SwiftUI's toolbar
/// system, still self-healing, still explicitly sized and never
/// `sizeToFit`.
final class KeyboardDoneBar: UIView {
    /// The band UIKit reserves above the keyboard. 44 is the standard
    /// accessory height and the number the device pass was run against.
    static let standardHeight: CGFloat = 44
    /// How far the button is held off the bar's edges. The bottom inset is
    /// the whole point: it is the clearance between the button and the
    /// first row of keys.
    private static let buttonInset: CGFloat = 4
    private static let trailingInset: CGFloat = 16

    private let height: CGFloat

    /// UIKit measures an `inputAccessoryView` through Auto Layout when it
    /// can, and through the frame when it cannot; stating the same number
    /// both ways is what stops the two paths from disagreeing. A
    /// disagreement here is not cosmetic - it is how this bar shipped 430
    /// points wide and 0 tall once already.
    override var intrinsicContentSize: CGSize {
        CGSize(width: UIView.noIntrinsicMetric, height: height)
    }

    init(width: CGFloat, height: CGFloat, target: Any, action: Selector) {
        self.height = height
        super.init(frame: CGRect(x: 0, y: 0, width: width, height: height))
        // The keyboard's width is what this has to match, and it is not
        // always the window's - a hardware keyboard or a resized scene
        // changes it without rebuilding the bar.
        autoresizingMask = .flexibleWidth
        accessibilityIdentifier = KeyboardExitIdentifiers.doneBar

        // Chrome, not app content: the same material family the system
        // puts behind its own keyboard accessories, so it tracks light and
        // dark without a palette of its own and reads as part of the
        // keyboard rather than as part of the form.
        let background = UIVisualEffectView(effect: UIBlurEffect(style: .systemChromeMaterial))
        background.frame = bounds
        background.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        background.isUserInteractionEnabled = false
        addSubview(background)

        var configuration = UIButton.Configuration.borderedProminent()
        configuration.title = "Done"
        configuration.cornerStyle = .capsule
        let button = UIButton(configuration: configuration)
        button.accessibilityIdentifier = KeyboardExitIdentifiers.doneButton
        button.addTarget(target, action: action, for: .touchUpInside)
        button.translatesAutoresizingMaskIntoConstraints = false
        addSubview(button)
        NSLayoutConstraint.activate([
            button.trailingAnchor.constraint(
                equalTo: trailingAnchor, constant: -Self.trailingInset
            ),
            button.centerYAnchor.constraint(equalTo: centerYAnchor),
            // An explicit height rather than top/bottom insets, so the
            // DEBUG negative control - which builds this bar zero points
            // tall - collapses the button with it instead of demanding a
            // negative height and having Auto Layout break one of the two
            // constraints for it.
            button.heightAnchor.constraint(
                equalToConstant: max(0, height - 2 * Self.buttonInset)
            ),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("KeyboardDoneBar is built in code only")
    }
}

/// Named so the UI test can find the one control this whole mechanism
/// exists to put on screen.
enum KeyboardExitIdentifiers {
    static let doneButton = "keyboard.done"
    /// Also how the bar is told apart from SwiftUI's own empty accessory
    /// host, which is installed regardless and is not a Done bar.
    static let doneBar = "keyboard.doneBar"
}

extension UIView {
    /// Which keyboards cannot be closed from inside themselves: a numeric
    /// pad has no return key at all, and a text view's return key inserts
    /// a newline.
    ///
    /// Read off the keyboard the field actually raises, rather than
    /// restated per field in an enum. The enum this replaces had to be
    /// hand-synced with the view and drifted - other tax shipped with a
    /// decimal pad nothing could close, because it had no focus value for
    /// the toolbar to key off (54286b6).
    var keyboardHasNoExitOfItsOwn: Bool {
        if self is UITextView { return true }
        guard let field = self as? UITextField else { return false }
        switch field.keyboardType {
        case .numberPad, .decimalPad, .phonePad, .asciiCapableNumberPad:
            return true
        default:
            return false
        }
    }
}

private extension UIView {
    /// The touched view is usually a private subview inside the text
    /// field, not the field itself, so the whole ancestry is checked.
    var isInsideTextInput: Bool {
        var view: UIView? = self
        while let current = view {
            if current is UITextField || current is UITextView {
                return true
            }
            view = current.superview
        }
        return false
    }
}
