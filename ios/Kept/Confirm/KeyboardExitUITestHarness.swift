#if DEBUG
import SwiftUI

/// Boots straight into the confirm screen for the UI test, with no server,
/// no session and no camera.
///
/// It presents through a `fullScreenCover` inside a `NavigationStack`
/// deliberately: that is how `ReceiptDetailView` presents the real thing,
/// and the presentation is not incidental to this bug - the toolbar the
/// Done button used to come from failed *because* of it. A harness that
/// presented the form any other way would test a screen the defect does
/// not live on.
///
/// Its options store reads nothing the app has cached (2026-10-31). The
/// real one offers whatever this simulator last fetched, and a past value
/// adds a menu to the vendor, category and payment rows: taller rows, a
/// different form, and `ConfirmAmountsUITests` tapping under the keyboard
/// for reasons nothing in the test could see. A harness has to open on the
/// same form every time, whoever last used this simulator.
///
/// Reached only via `-KeptUITestConfirmScreen` in the launch arguments,
/// and compiled out of shipped builds.
struct KeyboardExitUITestHarness: View {
    @StateObject private var options: ReceiptOptionsStore
    private let eventLogger: EventLogger
    @State private var model: ConfirmReceiptModel?

    init(api: any KeptAPI, eventLogger: EventLogger) {
        _options = StateObject(wrappedValue: ReceiptOptionsStore(api: api, defaults: Self.emptyDefaults()))
        self.eventLogger = eventLogger
    }

    /// A domain of its own, emptied on the way in.
    private static func emptyDefaults() -> UserDefaults {
        let suite = "KeptUITestHarness"
        guard let defaults = UserDefaults(suiteName: suite) else {
            preconditionFailure("\(suite) is not a usable defaults suite name")
        }
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    static var isRequested: Bool {
        ProcessInfo.processInfo.arguments.contains("-KeptUITestConfirmScreen")
    }

    /// Opens the form blank, with the server's second opinion landing on
    /// it - the chips, with no capture to drive them (2026-10-31).
    private static var opensOnServerChips: Bool {
        ProcessInfo.processInfo.arguments.contains("-KeptUITestServerChips")
    }

    var body: some View {
        Color.clear
            .fullScreenCover(item: $model) { presented in
                NavigationStack {
                    ConfirmReceiptView(
                        model: presented,
                        options: options,
                        eventLogger: eventLogger,
                        onSaved: {},
                        onSetAside: {}
                    )
                }
            }
            .onAppear {
                guard model == nil else { return }
                let form = ConfirmReceiptModel(draft: draft, saveAction: { _ in })
                if Self.opensOnServerChips {
                    form.applyServerSuggestions(ConfirmSuggestionSet(parse: ReceiptSuggestions(
                        totalCents: 21894,
                        hstCents: 734,
                        subtotalCents: 21160,
                        paymentMethod: "MASTERCARD",
                        purchasedAt: "2026-08-09",
                        vendor: "COSTCO WHOLESALE"
                    )))
                }
                model = form
            }
    }

    private var draft: CapturedReceiptDraft {
        CapturedReceiptDraft(
            imageData: onePixelPNG(),
            suggestions: Self.opensOnServerChips
                ? ReceiptSuggestions()
                : ReceiptSuggestions(
                    totalCents: 1234,
                    hstCents: 142,
                    subtotalCents: 1092,
                    purchasedAt: "2026-08-09",
                    vendor: "Test Vendor"
                ),
            ocrRawText: nil,
            capturedAt: Date(timeIntervalSince1970: 1_786_000_000),
            ocrFailureNote: nil
        )
    }

    /// The image section renders whatever it is given; a real one keeps
    /// the harness off the failure path so the test only ever fails for
    /// the reason it exists to catch.
    private func onePixelPNG() -> Data {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 1, height: 1))
        return renderer.image { context in
            UIColor.systemGray5.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 1, height: 1))
        }.pngData() ?? Data()
    }
}
#endif
