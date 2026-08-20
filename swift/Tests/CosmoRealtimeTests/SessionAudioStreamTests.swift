import AVFAudio
import Foundation
import LiveKit
import Testing

@testable import CosmoRealtime

/// The caller-owned audio publish rides LiveKit's process-wide audio engine
/// rather than a second track, so the slot state machine — one stream at a
/// time, microphone restored on teardown — is what keeps a session from
/// leaving the engine silenced for whoever runs next.
/// Runs fully offline: the detached-room hook passes the start guard and no
/// buffer is ever pushed, so no capture is opened.
@Suite("Audio-stream publish")
struct SessionAudioStreamTests {

    private func makeTransport() -> LiveKitSessionTransport {
        LiveKitSessionTransport(
            options: RealtimeClient.Options(apiKey: "test-key")
        )
    }

    @Test("startAudioStream without a connected room throws .notConnected")
    func startWithoutRoomThrows() async throws {
        let transport = makeTransport()
        await #expect(throws: RealtimeSessionError.notConnected) {
            try await transport.startAudioStream()
        }
        #expect(!transport._testAudioStreamLockHasValue(), "the guard must reject before claiming the slot")
    }

    @Test("one audio stream at a time")
    func slotIsExclusive() throws {
        let transport = makeTransport()

        try transport.claimAudioStreamSlot()
        #expect(throws: RealtimeSessionError.audioPublishAlreadyActive) {
            try transport.claimAudioStreamSlot()
        }

        transport.stopAudioStreamSlot()
        // Released, so the next claim succeeds — a slot that leaked would
        // strand the session with no way to publish audio again.
        try transport.claimAudioStreamSlot()
        transport.stopAudioStreamSlot()
    }

    @Test("stopping is idempotent")
    func stopIsIdempotent() async throws {
        let transport = makeTransport()
        try transport.claimAudioStreamSlot()

        await transport.stopAudioStream()
        await transport.stopAudioStream()

        #expect(!transport._testAudioStreamLockHasValue())
    }

    @Test("the microphone level is restored when the stream stops")
    func stopRestoresMicrophoneLevel() async throws {
        // The mixer is process-wide: a stream that silences the mic and never
        // puts it back leaves every later session muted with no visible cause.
        let mixer = AudioManager.shared.mixer
        let original = mixer.micVolume
        defer { mixer.micVolume = original }

        let transport = makeTransport()
        try transport.claimAudioStreamSlot()
        #expect(mixer.micVolume == 0, "a running stream must silence the device microphone")

        await transport.stopAudioStream()
        #expect(mixer.micVolume == original)
    }

    @Test("closing the transport restores the microphone of a running stream")
    func closeRestoresMicrophoneLevel() async throws {
        let mixer = AudioManager.shared.mixer
        let original = mixer.micVolume
        defer { mixer.micVolume = original }

        let transport = makeTransport()
        try transport.claimAudioStreamSlot()

        await transport.close()

        #expect(mixer.micVolume == original, "teardown must restore the microphone even with the stream still claimed")
        #expect(!transport._testAudioStreamLockHasValue())
    }

    @Test("pushing after the stream stops is inert")
    func pushAfterStopIsInert() async throws {
        let transport = makeTransport()
        try transport.claimAudioStreamSlot()
        await transport.stopAudioStream()

        let format = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1)!
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 480)!
        buffer.frameLength = 480
        // No slot, so a push from a capture callback that outlived the stream
        // must not reach the engine or crash.
        transport.pushAudioBuffer(buffer)

        #expect(!transport._testAudioStreamLockHasValue())
    }
}

/// The session-level contract: publishing caller-owned audio must also open
/// the server-side mute gate, or the agent ignores the track that was just
/// published. Driven through the fake transport — no LiveKit involved.
@Suite("RealtimeSession audio-stream contract")
struct SessionAudioStreamContractTests {

    @Test("startAudioStream clears the server mute gate")
    func startAudioStreamUnmutes() async throws {
        let transport = FakeSessionTransport()
        let session = RealtimeSession(transport: transport)
        try await session._start(config: SessionConfig(), micMuted: true)

        try await session.startAudioStream()

        #expect(await transport.audioStreamActive)
        let mutes = await transport.sent.map(observeSentFrame).filter { $0.type == "mute" }
        #expect(mutes.count == 1)
        #expect(mutes.first?.fields["muted"] == .bool(false),
                "the publish must unmute so the agent listens to the pushed audio")
        #expect(await transport.micEnabled == true)
    }

    @Test("a failed unmute releases the stream instead of stranding it")
    func failedUnmuteRollsBack() async throws {
        struct MicCaptureDenied: Error {}
        let transport = FakeSessionTransport()
        let session = RealtimeSession(transport: transport)
        try await session._start(config: SessionConfig(), micMuted: true)
        await transport.scriptMicError(MicCaptureDenied())

        await #expect(throws: MicCaptureDenied.self) {
            try await session.startAudioStream()
        }
        // Holding the voice after throwing would leave the session with a
        // silenced microphone the caller never asked to silence.
        #expect(await !transport.audioStreamActive)
    }

    @Test("stopping a stream on a muted session leaves no live microphone")
    func stopRestoresMutedSession() async throws {
        // The stream publishes the local audio track to reach the wire. A
        // session the host presents as muted must not be left streaming a
        // device the caller never enabled.
        let transport = FakeSessionTransport()
        let session = RealtimeSession(transport: transport)
        try await session._start(config: SessionConfig(), micMuted: true)
        try await session.startAudioStream()

        await session.stopAudioStream()

        #expect(await transport.micEnabled == false)
        let mutes = await transport.sent.map(observeSentFrame).filter { $0.type == "mute" }
        #expect(mutes.last?.fields["muted"] == .bool(true),
                "the server gate must close behind a session left with no voice")
    }

    @Test("stopping a stream gives the voice back to a microphone that had it")
    func stopRestoresLiveMicrophone() async throws {
        let transport = FakeSessionTransport()
        let session = RealtimeSession(transport: transport)
        try await session._start(config: SessionConfig(), micMuted: false)
        try await session.startAudioStream()

        await session.stopAudioStream()

        #expect(await transport.micEnabled == true, "a microphone that held the voice keeps it")
        let mutes = await transport.sent.map(observeSentFrame).filter { $0.type == "mute" }
        #expect(mutes.last?.fields["muted"] == .bool(false))
    }

    @Test("a failed unmute leaves no live microphone behind")
    func failedUnmuteLeavesNoMicrophone() async throws {
        struct GateRefused: Error {}
        let transport = FakeSessionTransport()
        let session = RealtimeSession(transport: transport)
        try await session._start(config: SessionConfig(), micMuted: true)
        await transport.scriptSendError(GateRefused())

        await #expect(throws: GateRefused.self) {
            try await session.startAudioStream()
        }
        // Reporting the start as failed while the microphone publishes would
        // stream a muted session's audio with nothing to turn it off.
        #expect(await transport.micEnabled == false)
    }

    @Test("startAudioStream on a session that never started throws")
    func startBeforeSessionStartThrows() async throws {
        let transport = FakeSessionTransport()
        let session = RealtimeSession(transport: transport)

        await #expect(throws: RealtimeSessionError.notConnected) {
            try await session.startAudioStream()
        }
        #expect(await !transport.audioStreamActive)
    }
}
