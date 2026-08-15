import Foundation
import Testing

@testable import CosmoRealtime

/// The ``micMuted`` start option must reach the transport so a session the
/// host presents as "muted" joins without publishing audio during the connect
/// window. The real no-publish behavior (``ConnectOptions(enableMicrophone:)``
/// + the deferred mic publish) is exercised against a live ``livekit-server``
/// in the E2E suite / Mac-port real-build testing; this pins the API contract.
@Suite("RealtimeSession mic-muted join")
struct SessionMicMutedTests {

    @Test("start threads micMuted=true to the transport")
    func micMutedThreaded() async throws {
        let transport = FakeSessionTransport()
        let session = RealtimeSession(transport: transport)
        try await session._start(config: SessionConfig(), micMuted: true)
        #expect(await transport.connectedMicMuted == true)
    }

    @Test("start defaults to publishing the mic")
    func micMutedDefaultsFalse() async throws {
        let transport = FakeSessionTransport()
        let session = RealtimeSession(transport: transport)
        try await session._start(config: SessionConfig())
        #expect(await transport.connectedMicMuted == false)
    }

    @Test("setMuted surfaces a failed first-unmute mic publish")
    func setMutedSurfacesMicPublishFailure() async throws {
        struct MicCaptureDenied: Error {}
        let transport = FakeSessionTransport()
        let session = RealtimeSession(transport: transport)
        try await session._start(config: SessionConfig(), micMuted: true)
        await transport.scriptMicError(MicCaptureDenied())
        await #expect(throws: MicCaptureDenied.self) {
            try await session.setMuted(false)
        }
    }
}
