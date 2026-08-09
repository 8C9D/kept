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
/// Reached only via `-KeptUITestConfirmScreen` in the launch arguments,
/// and compiled out of shipped builds.
struct KeyboardExitUITestHarness: View {
    @State private var model: ConfirmReceiptModel?

    static var isRequested: Bool {
        ProcessInfo.processInfo.arguments.contains("-KeptUITestConfirmScreen")
    }

    var body: some View {
        Color.clear
            .fullScreenCover(item: $model) { presented in
                NavigationStack {
                    ConfirmReceiptView(model: presented, onSaved: {}, onSetAside: {})
                }
            }
            .onAppear {
                guard model == nil else { return }
                model = ConfirmReceiptModel(draft: draft, saveAction: { _ in })
            }
    }

    private var draft: CapturedReceiptDraft {
        CapturedReceiptDraft(
            imageData: onePixelPNG(),
            suggestions: ReceiptSuggestions(
                totalCents: 1234,
                hstCents: 142,
                subtotalCents: 1092,
                vendorTaxNumber: "123456789RT0001",
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
