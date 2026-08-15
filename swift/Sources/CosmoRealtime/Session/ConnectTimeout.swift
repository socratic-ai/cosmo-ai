import Foundation
import os

/// Run `operation` with a hard `seconds` deadline, throwing
/// ``RealtimeError/connectTimeout`` if it doesn't settle in time.
///
/// Unstructured tasks + a one-shot ``CheckedContinuation`` (guarded by an
/// ``OSAllocatedUnfairLock``) rather than a task group, so a non-cancellable
/// operation (LiveKit's ``Room.connect`` doesn't honor cooperative cancellation
/// cleanly — the OS TCP timeout dominates on an unroutable URL) doesn't keep the
/// caller waiting past the deadline; a `withThrowingTaskGroup` would block until
/// every child settled on closure exit.
///
/// `onLateSettlement` runs ONCE, after the operation actually returns/throws, IF
/// the timeout already won (the caller has moved on) — letting the caller
/// schedule cleanup (e.g. `room.disconnect()`) against a settled state instead
/// of racing a still-in-flight non-cancellable operation.
func _withConnectTimeout(
    seconds: TimeInterval,
    operation: @escaping @Sendable () async throws -> Void,
    onLateSettlement: @escaping @Sendable () async -> Void = {}
) async throws {
    let resumed = OSAllocatedUnfairLock<Bool>(initialState: false)
    return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
        let opTask = Task<Void, Never> {
            let opResult: Result<Void, Error>
            do {
                try await operation()
                opResult = .success(())
            } catch {
                opResult = .failure(error)
            }
            let alreadyResumed = resumed.withLock { current -> Bool in
                let was = current
                current = true
                return was
            }
            if !alreadyResumed {
                switch opResult {
                case .success: cont.resume()
                case .failure(let e): cont.resume(throwing: e)
                }
            } else {
                // Timeout already won; caller has moved on. Run late-settlement
                // cleanup against the now-resolved operation state.
                await onLateSettlement()
            }
        }
        Task<Void, Never> {
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            let alreadyResumed = resumed.withLock { current -> Bool in
                let was = current
                current = true
                return was
            }
            if !alreadyResumed {
                opTask.cancel()
                cont.resume(throwing: RealtimeError.connectTimeout)
            }
        }
    }
}
