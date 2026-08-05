import Foundation

/// A one-shot latch for ordering concurrency tests: a stubbed call parks
/// on `wait()` so the test can interleave other work deterministically,
/// then `open()` releases it. Once opened it never blocks again.
actor Gate {
    private var opened = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        if opened { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func open() {
        opened = true
        for waiter in waiters {
            waiter.resume()
        }
        waiters.removeAll()
    }

    var hasWaiters: Bool {
        !waiters.isEmpty
    }
}
