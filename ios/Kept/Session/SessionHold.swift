import SwiftUI

/// Applied to the root of a screen holding work that exists nowhere else, so
/// a session dying behind it cannot tear it down (2026-10-31,
/// `SessionController.beginHold`).
///
/// On the presented content rather than on whatever presents it, so every
/// way onto the screen and every way off it is covered by construction. The
/// `isHolding` guard is there because SwiftUI can repeat `onAppear` for a
/// view coming back from underneath another presentation, and an unbalanced
/// hold would swallow every later rejection.
private struct HoldsSession: ViewModifier {
    @EnvironmentObject private var session: SessionController
    @State private var isHolding = false

    func body(content: Content) -> some View {
        content
            .onAppear {
                guard !isHolding else { return }
                isHolding = true
                session.beginHold()
            }
            .onDisappear {
                guard isHolding else { return }
                isHolding = false
                session.endHold()
            }
    }
}

extension View {
    func holdsSession() -> some View {
        modifier(HoldsSession())
    }
}
