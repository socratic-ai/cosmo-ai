import AVFAudio
import Foundation
import os

// MARK: - Audio streams
extension RealtimeSession {

    private static let audioStreamLog = Logger(
        subsystem: CosmoRealtimeLog.subsystem, category: "session-audiostream"
    )

    /// Take the session's voice for caller-owned audio — a synthetic
    /// generator, file replay, or any pipeline the SDK cannot capture
    /// itself — then feed it with ``pushAudioBuffer(_:)``. For the device
    /// microphone use ``setMuted(_:)``.
    ///
    /// A session carries one voice, so while the stream is running the device
    /// microphone is silenced and the agent hears exactly the pushed buffers;
    /// ``stopAudioStream()`` gives it back. The server-side mute gate is
    /// cleared as part of the publish. Throws
    /// ``RealtimeSessionError/audioPublishAlreadyActive`` while a stream is
    /// already running, and ``RealtimeSessionError/notConnected`` outside a
    /// live session.
    public func startAudioStream() async throws {
        try _assertSendable()
        try await transport.startAudioStream()
        do {
            try await setMuted(false)
        } catch {
            // The stream published the local audio track to reach the wire.
            // Leaving it published on a failed start would hand the agent a
            // live microphone while reporting the start as failed.
            await transport.stopAudioStream()
            throw error
        }
    }

    /// Push one buffer into the running stream. Safe to call from an
    /// audio-render thread. Buffers are resampled to the engine's format,
    /// and a push with no stream running is inert.
    public nonisolated func pushAudioBuffer(_ buffer: AVAudioPCMBuffer) {
        transport.pushAudioBuffer(buffer)
    }

    /// Give the voice back to whatever held it before the stream. Idempotent,
    /// and pushes after it are inert.
    ///
    /// A session that had no microphone publishing — one started with
    /// ``micMuted`` — is left with none, and the server gate closes behind it.
    /// One that did keeps it, gate open.
    public func stopAudioStream() async {
        let microphoneHasVoice = await transport.stopAudioStream()
        do {
            try await setMuted(!microphoneHasVoice)
        } catch {
            // The track is already unpublished, so the agent hears nothing
            // either way; the gate is the server's view of that.
            Self.audioStreamLog.error(
                "audio stream stopped but the mute gate did not follow: \(error.localizedDescription, privacy: .public)"
            )
        }
    }
}
