import SwiftUI

/// The two loading-state fragments every screen needs, extracted so they
/// exist once instead of as copy-adapted variants (wave-3 reviewer
/// finding; the same reasoning as PendingBadge and FieldRow).

/// A failure message with its Retry action.
struct LoadFailureView: View {
    let message: String
    let retry: () async -> Void

    var body: some View {
        VStack(spacing: 8) {
            Text(message)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button("Retry") {
                Task { await retry() }
            }
            .buttonStyle(.bordered)
        }
        .frame(maxWidth: .infinity)
        .listRowSeparator(.hidden)
    }
}

/// A horizontally centered spinner, with an optional label, sized for a
/// list row.
struct CenteredProgressRow: View {
    var label: String?

    var body: some View {
        HStack {
            Spacer()
            if let label {
                ProgressView(label)
            } else {
                ProgressView()
            }
            Spacer()
        }
        .listRowSeparator(.hidden)
    }
}
