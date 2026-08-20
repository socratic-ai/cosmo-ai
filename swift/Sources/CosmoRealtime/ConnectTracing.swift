import Foundation
import LiveKit
import os

/// Routes LiveKit's internal operation spans into the unified
/// `socratic.cosmo-realtime` os_log subsystem so a single `log` predicate
/// captures app + SDK + LiveKit connect timing together.
///
/// LiveKit instruments `Room.connect` with a span that records
/// `ws_open → join_recv → pc_created → offer_sent → answer_sent →
/// pc_connected → room_connected`, i.e. the full signaling-vs-ICE
/// breakdown of the SDK's `room_ms` phase. `Span.description` already
/// formats per-event deltas + total, so we just forward it.
///
/// Internal on purpose: it conforms to LiveKit's `Tracing` and traffics in
/// `Span`, so making it public would put the vendor's types on our surface
/// and pin consumers to this transport. ``RealtimeSession/installConnectTracing()``
/// is the vendor-free way in.
final class CosmoLiveKitTracer: Tracing, Sendable {
    private static let log = Logger(subsystem: CosmoRealtimeLog.subsystem, category: "livekit-trace")

    init() {}

    @discardableResult
    func beginSpan(_ name: String) -> Span {
        let span = Span(label: name)
        span.onEnd = { span in
            // .notice so connect spans survive in `log show` without a live stream.
            Self.log.notice("livekit span \(span.description, privacy: .public)")
        }
        return span
    }
}

public extension RealtimeClient {
    /// Install connect-latency tracing. Call once at app launch, BEFORE any
    /// `Room` operation — LiveKit freezes its tracer/logger on first use
    /// (`sharedTracing`/`sharedLogger` are lazily-initialized globals).
    ///
    /// - The connect-span tracer is always installed (one low-volume span per
    ///   connect, logged at `.notice` under `socratic.cosmo-realtime`).
    /// - Setting `COSMO_REALTIME_LIVEKIT_LOG` (`debug`/`info`/`warning`/`error`)
    ///   additionally enables LiveKit's verbose internal logging (RTC/ICE/FFI,
    ///   plus the AudioManager + track-publish detail that decomposes `mic_ms`)
    ///   under the `io.livekit.sdk` subsystem. Off by default — it's noisy.
    static func installConnectTracing() {
        LiveKitSDK.setTracing(CosmoLiveKitTracer())

        let raw = ProcessInfo.processInfo.environment["COSMO_REALTIME_LIVEKIT_LOG"]?
            .trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard let raw, !raw.isEmpty else { return }
        let level: LogLevel
        switch raw {
        case "error": level = .error
        case "warning", "warn": level = .warning
        case "info": level = .info
        default: level = .debug
        }
        LiveKitSDK.setLogLevel(level)
    }
}
