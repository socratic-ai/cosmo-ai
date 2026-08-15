import Foundation

// MARK: - Cancellable

/// A handle returned by a listener registration (e.g.
/// ``RealtimeSession/onScreenShareFailed(_:)``). Call ``cancel()`` to
/// deregister the listener.
///
/// Listener removal is dispatched onto the transport's actor, so ``cancel()``
/// returns before the handler is guaranteed to stop firing. Callers that
/// must guarantee no further callbacks (e.g. tearing down captured state)
/// should use ``cancelAndWait()`` instead.
public struct Cancellable: Sendable {
    private let _cancel: @Sendable () -> Task<Void, Never>

    /// Construct from a synchronous cancellation closure. The closure runs
    /// fire-and-forget; ``cancelAndWait()`` will complete as soon as the
    /// closure returns.
    public init(_ cancel: @escaping @Sendable () -> Void) {
        self._cancel = { Task { cancel() } }
    }

    /// Construct from a closure that returns the actor-isolated removal
    /// task. Used internally by listener registrations so
    /// ``cancelAndWait()`` can await the dispatched removal.
    internal init(awaitable: @escaping @Sendable () -> Task<Void, Never>) {
        self._cancel = awaitable
    }

    /// Fire-and-forget deregistration. Returns immediately; the underlying
    /// removal may complete asynchronously on the client actor.
    public func cancel() { _ = _cancel() }

    /// Deregister and await completion of any actor-isolated removal
    /// work. Use when you need to guarantee no further callbacks fire
    /// before releasing captured state.
    public func cancelAndWait() async { await _cancel().value }
}

// MARK: - Errors

public enum RealtimeError: Error, LocalizedError, Equatable {
    /// REST session-start failed.
    case sessionStartFailed(message: String)
    case notConnected
    /// A session start was attempted on a handle whose previous start already
    /// succeeded. A session is single-shot — start a new one to reconnect.
    case alreadyConnected
    /// A connect exceeded the configured timeout waiting for either the REST
    /// session-start or the LiveKit ``Room/connect`` to return. Surfaced as a
    /// distinct case so callers can branch on "wedged backend / signaling" vs
    /// other failure modes.
    case connectTimeout
    case screenShareUnavailable
    /// A caller passed a payload that would violate a wire-protocol
    /// invariant (e.g. attempting to wrap an ``envelope-chunk`` inside
    /// another envelope). The associated message names the violation.
    case invalidWirePayload(String)

    public var errorDescription: String? {
        switch self {
        case .sessionStartFailed(let message): return "Session start failed: \(message)"
        case .notConnected: return "The realtime session is not connected."
        case .alreadyConnected: return "The realtime session already started (or is in flight); start a new session to reconnect."
        case .connectTimeout: return "Realtime connect exceeded the configured timeout."
        case .screenShareUnavailable: return "Screen share is unavailable: LiveKit BufferCapturer could not be created."
        case .invalidWirePayload(let detail): return "Invalid wire payload: \(detail)"
        }
    }
}
