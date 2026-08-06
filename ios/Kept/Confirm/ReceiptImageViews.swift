import SwiftUI

/// Where a receipt image's bytes come from: a presigned URL for stored
/// receipts, or the scanned bytes still in memory for a capture being
/// confirmed before it uploads (wave-5 gate ratification).
enum ReceiptImageSource: Equatable {
    case remote(URL)
    case local(Data)
}

/// The confirm screen's inline receipt image: the person is checking
/// numbers against paper, so the image loads eagerly and failures say so.
struct ReceiptImageView: View {
    let source: ReceiptImageSource

    var body: some View {
        switch source {
        case .remote(let url):
            AsyncImage(url: url) { phase in
                switch phase {
                case .empty:
                    CenteredProgressRow()
                case .success(let image):
                    image
                        .resizable()
                        .scaledToFit()
                case .failure:
                    loadFailureLabel
                @unknown default:
                    EmptyView()
                }
            }
        case .local(let data):
            if let uiImage = UIImage(data: data) {
                Image(uiImage: uiImage)
                    .resizable()
                    .scaledToFit()
            } else {
                // The scanner produced these bytes moments ago; failing to
                // re-decode them is stated, same as a failed download.
                loadFailureLabel
            }
        }
    }

    private var loadFailureLabel: some View {
        Label(
            "The image could not be loaded.",
            systemImage: "photo.badge.exclamationmark"
        )
        .font(.footnote)
        .foregroundStyle(.secondary)
    }
}

/// Tap-to-zoom (spec §7.2: "tappable to zoom - they must be able to see
/// the paper"): pinch to magnify, double-tap to toggle, drag to pan.
struct ZoomableImageSheet: View {
    let source: ReceiptImageSource

    @Environment(\.dismiss) private var dismiss
    @State private var steadyZoom: CGFloat = 1
    @GestureState private var pinchZoom: CGFloat = 1

    private var zoom: CGFloat {
        min(max(steadyZoom * pinchZoom, 1), 6)
    }

    var body: some View {
        NavigationStack {
            ScrollView([.horizontal, .vertical]) {
                ReceiptImageView(source: source)
                    .scaleEffect(zoom, anchor: .center)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .defaultScrollAnchor(.center)
            .gesture(
                MagnificationGesture()
                    .updating($pinchZoom) { value, state, _ in
                        state = value
                    }
                    .onEnded { value in
                        steadyZoom = min(max(steadyZoom * value, 1), 6)
                    }
            )
            .onTapGesture(count: 2) {
                steadyZoom = steadyZoom > 1 ? 1 : 2.5
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}
