import Foundation
import Testing
@testable import CosmoRealtime

/// Agent playback-gain control on the external-protocol stack.
/// `RealtimeSession` forwards to the transport, which owns the
/// clamp + stored desired gain (re-applied to a track that attaches later).
/// These drive the public `RealtimeSession.setAgentPlaybackVolume` against a
/// real ``LiveKitSessionTransport`` and assert the stored gain — no LiveKit
/// server, no real track (applying gain to a live track is E2E/on-device).
@Suite("Agent playback volume (external session)")
struct AgentPlaybackVolumeSessionTests {

    private func makeTransport() -> LiveKitSessionTransport {
        LiveKitSessionTransport(
            options: RealtimeClient.Options(
                apiKey: "test-key"
            )
        )
    }

    @Test("defaults to unity gain")
    func defaultsToUnity() {
        #expect(makeTransport().desiredAgentVolume.withLock { $0 } == 1.0)
    }

    @Test("RealtimeSession forwards an in-range gain to the transport")
    func forwardsInRange() {
        let transport = makeTransport()
        let session = RealtimeSession(transport: transport)
        session.setAgentPlaybackVolume(0.25)
        #expect(transport.desiredAgentVolume.withLock { $0 } == 0.25)
    }

    @Test("RealtimeSession clamps a gain above unity to 1")
    func clampsHigh() {
        let transport = makeTransport()
        RealtimeSession(transport: transport).setAgentPlaybackVolume(2.5)
        #expect(transport.desiredAgentVolume.withLock { $0 } == 1.0)
    }

    @Test("RealtimeSession clamps a negative gain to 0 (silence)")
    func clampsLow() {
        let transport = makeTransport()
        RealtimeSession(transport: transport).setAgentPlaybackVolume(-1)
        #expect(transport.desiredAgentVolume.withLock { $0 } == 0.0)
    }
}
