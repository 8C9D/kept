import SwiftUI

/// Renders the confirm queue's phases: a form per pending receipt, then
/// done. Used by the capture flow right after a scan and standalone from
/// Home's pending badge - the same sitting-length loop either way
/// (spec §6A).
struct ConfirmQueueView: View {
    @ObservedObject var queue: ConfirmQueueModel
    @ObservedObject var options: ReceiptOptionsStore
    let eventLogger: EventLogger
    /// Handed straight to `ConfirmReceiptView` for proposal #8's "open the
    /// matching receipt" affordance - not read by anything in this file,
    /// which otherwise talks to the server only through `queue` (a
    /// `ConfirmQueueModel`, whose own `any KeptAPI` is private and not
    /// this type's business to reach into).
    let api: any KeptAPI
    let onFinished: () -> Void

    var body: some View {
        Group {
            switch queue.phase {
            case .loading:
                VStack(spacing: 8) {
                    ProgressView("Loading next receipt")
                    if let pendingCount = queue.pendingCount, pendingCount > 0 {
                        // The same server-counted number as the Home badge:
                        // how much of the pile is left this sitting.
                        Text("\(pendingCount) pending")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)

            case .failed(let message):
                LoadFailureView(message: message) {
                    await queue.loadNext()
                }
                .padding()

            case .confirming(let model):
                ConfirmReceiptView(
                    model: model,
                    options: options,
                    eventLogger: eventLogger,
                    api: api,
                    onSaved: { await queue.advanceAfterSave() },
                    onSetAside: { await queue.setAsideCurrent() }
                )
                // A fresh identity per receipt: focus state and scroll
                // position must not leak from the last form into the next.
                .id(model.receiptId)

            case .done(let setAsideCount):
                // A summary earns its screen only when a batch was worked
                // down or something was set aside and needs saying. After
                // a single confirm - the everyday case - any recap is a
                // success modal, which §10A.1 forbids: straight to Home.
                if queue.handledCount > 1 || setAsideCount > 0 {
                    queueDone(setAsideCount: setAsideCount)
                } else {
                    Color.clear.onAppear { onFinished() }
                }
            }
        }
    }

    private func queueDone(setAsideCount: Int) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "checkmark.circle")
                .font(.system(size: 44))
                .foregroundStyle(.green)
            Text(setAsideCount == 0 ? "Queue clear" : "Queue done for now")
                .font(.headline)
            if setAsideCount > 0 {
                // The set-aside receipts stay pending server-side; the Home
                // badge keeps counting them (spec §5.2a: visible and
                // slightly annoying).
                Text("\(setAsideCount) set aside for later - still counted as pending.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Button("Done") { onFinished() }
                .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// Home's standalone entry into the queue (badge tap): owns the queue
/// model for the presentation's lifetime and starts it loading. The
/// capture flow does not use this - its queue starts only after the batch
/// has saved.
struct ConfirmQueueCover: View {
    @StateObject private var queue: ConfirmQueueModel
    @ObservedObject private var options: ReceiptOptionsStore
    private let api: APIClient
    private let eventLogger: EventLogger
    private let onFinished: () -> Void

    init(
        api: APIClient,
        options: ReceiptOptionsStore,
        eventLogger: EventLogger,
        onFinished: @escaping () -> Void
    ) {
        _queue = StateObject(wrappedValue: ConfirmQueueModel(api: api))
        self.options = options
        self.api = api
        self.eventLogger = eventLogger
        self.onFinished = onFinished
    }

    var body: some View {
        NavigationStack {
            ConfirmQueueView(queue: queue, options: options, eventLogger: eventLogger, api: api, onFinished: onFinished)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Close") { onFinished() }
                    }
                }
        }
        .task {
            await queue.loadNext()
        }
    }
}
