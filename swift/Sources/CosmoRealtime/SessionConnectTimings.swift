import CosmoRealtimeAPI
import Foundation

/// Server-side phase breakdown of `POST /session/start` (milliseconds),
/// echoed in the start response. Joined with the client connect phases in
/// the startup-waterfall event so each millisecond of connect latency is
/// attributable to client, network, or server.
public typealias RealtimeSessionStartTimings =
    CosmoRealtimeAPI.Components.Schemas.SessionStartTimings

/// Per-session connect-latency snapshot: the client-measured phases of the
/// connect plus the server's own breakdown of session start. Sink-agnostic —
/// the SDK builds it; consumers decide where to report it. Every field is
/// `nil` until ``connect()`` completes.
public struct SessionConnectTimings: Sendable, Equatable {
    // Client-measured connect phases (milliseconds). `ws` is the REST
    // session-start, `room` the LiveKit join, `mic` the mic-publish (0 for a
    // muted join, which publishes nothing), `total` the whole connect through
    // connect-ready. The phases do not necessarily sum to `total`: when the
    // room was created ahead of the start, `ws` and `room` overlap.
    public let wsMs: Double?
    public let roomMs: Double?
    public let micMs: Double?
    public let totalConnectMs: Double?

    /// Server-side session-start phases from the start response; `nil` on
    /// older backends.
    public let serverTimings: RealtimeSessionStartTimings?

    public init(
        wsMs: Double?,
        roomMs: Double?,
        micMs: Double?,
        totalConnectMs: Double?,
        serverTimings: RealtimeSessionStartTimings? = nil
    ) {
        self.wsMs = wsMs
        self.roomMs = roomMs
        self.micMs = micMs
        self.totalConnectMs = totalConnectMs
        self.serverTimings = serverTimings
    }
}
