import SwiftUI
import UIKit

/// Tap anywhere that is not a text field, and the keyboard goes away.
///
/// This is UIKit because SwiftUI cannot express "a tap no field claimed".
/// A `TapGesture` on the Form races the tapped `TextField`'s own focus:
/// moving from one money field to the next would sometimes dismiss the
/// keyboard instead of moving, and a tap inside the focused field to
/// reposition the cursor would close it outright. A gesture recognizer can
/// be asked, per touch, whether that touch landed on a text input, and
/// stand down when it did - which is the actual rule.
///
/// It never swallows anything (`cancelsTouchesInView = false`), so every
/// row, button and field behaves exactly as it did before; the recognizer
/// only ever calls `endEditing`, and SwiftUI's `@FocusState` follows the
/// resigned responder back to nil on its own.
///
/// Place it as a background: it draws nothing and takes no touches itself,
/// it is only there to find the window and to leave with the screen.
struct DismissesKeyboardOnOutsideTap: UIViewRepresentable {
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
    /// window, `didMoveToWindow` fires with nil, and the recognizer comes
    /// off with it. Nothing is left on the window for other screens.
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
        }

        private func detach() {
            if let recognizer {
                window?.removeGestureRecognizer(recognizer)
            }
            recognizer = nil
            window = nil
        }

        @objc private func dismissKeyboard() {
            window?.endEditing(true)
        }

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
