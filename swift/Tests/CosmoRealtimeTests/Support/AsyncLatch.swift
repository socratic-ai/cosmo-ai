import Foundation
import Testing

/// A single-shot or counting async latch for deterministic test
/// synchronization. Tests await `wait()`; handlers under test call
/// `signal()`. Avoids fixed sleeps.
///
/// If `wait()` times out before the latch fully signals, it records a
/// Swift Testing issue so the calling test fails rather than silently
/// passing on a never-arrived event. Callers don't have to remember to
/// assert on the return value.
actor AsyncLatch {
    private let label: String
    private let initialCount: Int
    private var remaining: Int
    private var continuation: CheckedContinuation<Void, Never>?
    private var timedOut: Bool = false

    init(count: Int = 1, label: String = "latch") {
        self.label = label
        self.initialCount = count
        self.remaining = count
    }

    func signal() {
        guard remaining > 0 else { return }
        remaining -= 1
        if remaining == 0 {
            continuation?.resume()
            continuation = nil
        }
    }

    /// Await until the latch fully signals or `timeout` elapses. On
    /// timeout, records a Swift Testing issue (so the calling test
    /// fails) and returns. The recorded issue includes the latch
    /// label and how many signals were missing.
    func wait(
        timeout: TimeInterval = 1.0,
        sourceLocation: SourceLocation = #_sourceLocation
    ) async {
        if remaining == 0 { return }
        await withTaskGroup(of: Void.self) { group in
            group.addTask {
                await withCheckedContinuation { cont in
                    Task { await self.setContinuation(cont) }
                }
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                await self.cancelWait()
            }
            await group.next()
            group.cancelAll()
        }
        if timedOut {
            let missing = remaining
            Issue.record(
                "AsyncLatch '\(label)' timed out after \(timeout)s with \(missing)/\(initialCount) signal(s) missing — handler may not have been invoked",
                sourceLocation: sourceLocation
            )
        }
    }

    private func setContinuation(_ cont: CheckedContinuation<Void, Never>) {
        if remaining == 0 {
            cont.resume()
        } else {
            self.continuation = cont
        }
    }

    private func cancelWait() {
        guard remaining > 0 else { return }
        timedOut = true
        if let c = continuation {
            c.resume()
            continuation = nil
        }
    }
}
