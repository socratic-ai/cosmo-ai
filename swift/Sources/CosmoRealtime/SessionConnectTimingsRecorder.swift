import Foundation
import os

/// Collects the connect-phase timings the transport measures and the
/// server-side breakdown from the start response, then hands back a
/// ``SessionConnectTimings`` on demand. Lock-guarded and ``Sendable``
/// because it's written during connect and read at terminal close.
final class SessionConnectTimingsRecorder: Sendable {
    private struct State {
        var wsMs: Double?
        var roomMs: Double?
        var micMs: Double?
        var totalMs: Double?
        var serverTimings: RealtimeSessionStartTimings?
    }

    private let state = OSAllocatedUnfairLock<State>(initialState: State())

    func setConnectPhases(wsMs: Double, roomMs: Double, micMs: Double, totalMs: Double) {
        state.withLock {
            $0.wsMs = wsMs
            $0.roomMs = roomMs
            $0.micMs = micMs
            $0.totalMs = totalMs
        }
    }

    func setServerTimings(_ timings: RealtimeSessionStartTimings) {
        state.withLock { $0.serverTimings = timings }
    }

    func snapshot() -> SessionConnectTimings {
        state.withLock { s in
            SessionConnectTimings(
                wsMs: s.wsMs,
                roomMs: s.roomMs,
                micMs: s.micMs,
                totalConnectMs: s.totalMs,
                serverTimings: s.serverTimings
            )
        }
    }
}
