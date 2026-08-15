import AVFAudio
import Foundation
import LiveKit
import os

/// State for the one caller-owned audio publish: what to put back when it
/// stops. The mixer level is process-wide, and the stream publishes the local
/// audio track whether or not the caller ever asked for a live microphone, so
/// both have to be restored or the session is left streaming a device the
/// caller never enabled.
final class AudioStreamState: @unchecked Sendable {
    let restoreMicVolume: Float
    let micWasPublishing: Bool

    init(restoreMicVolume: Float, micWasPublishing: Bool) {
        self.restoreMicVolume = restoreMicVolume
        self.micWasPublishing = micWasPublishing
    }
}

// MARK: - Caller-owned audio publish
extension LiveKitSessionTransport {

    fileprivate static let audioStreamLog = Logger(subsystem: CosmoRealtimeLog.subsystem, category: "session-audiostream")

    /// Take the session's voice for a caller-owned audio publish.
    ///
    /// LiveKit's Apple audio path renders every local source through one
    /// shared engine into a single published audio track, so this routes
    /// pushed buffers into that engine rather than creating a second
    /// track. Two consequences the caller sees: the local audio track is
    /// published if it was not already, and the device microphone is
    /// silenced for the duration so the agent hears exactly the pushed
    /// buffers. Throws ``RealtimeSessionError/audioPublishAlreadyActive``
    /// while a stream is already running.
    func startAudioStream() async throws {
        guard let room else {
            throw RealtimeSessionError.notConnected
        }
        try claimAudioStreamSlot(micWasPublishing: room.localParticipant.isMicrophoneEnabled())
        do {
            // Pushed buffers reach the wire only through a published local
            // audio track — without one the engine's input path is never
            // connected and every push is silently dropped.
            try await setMicrophoneEnabled(true)
        } catch {
            _ = stopAudioStreamSlot()
            throw error
        }
    }

    /// Take the single audio-stream slot and silence the device microphone.
    /// Split from ``startAudioStream`` so the slot's exclusivity stays
    /// testable without opening a real microphone.
    nonisolated func claimAudioStreamSlot(micWasPublishing: Bool = false) throws {
        let mixer = AudioManager.shared.mixer
        try audioStreamLock.withLock { current in
            guard current == nil else {
                throw RealtimeSessionError.audioPublishAlreadyActive
            }
            current = AudioStreamState(
                restoreMicVolume: mixer.micVolume, micWasPublishing: micWasPublishing
            )
        }
        mixer.micVolume = 0
    }

    /// Push one buffer into the running stream. Inert when none is running,
    /// so a push from a capture callback that outlived ``stopAudioStream``
    /// is dropped rather than mixed into a session that no longer wants it.
    nonisolated func pushAudioBuffer(_ buffer: AVAudioPCMBuffer) {
        guard audioStreamLock.withLock({ $0 }) != nil else { return }
        AudioManager.shared.mixer.capture(appAudio: buffer)
    }

    /// Put back what the stream displaced, and report whether the microphone
    /// holds the voice afterwards. Idempotent.
    ///
    /// The stream published the local audio track to reach the wire. Leaving it
    /// published would hand the agent a live microphone the caller never
    /// enabled — on a session started muted, one it explicitly did not.
    @discardableResult
    func stopAudioStream() async -> Bool {
        guard let state = stopAudioStreamSlot() else { return false }
        guard state.micWasPublishing else {
            try? await setMicrophoneEnabled(false)
            return false
        }
        return true
    }

    /// Clear the audio-stream slot and put the microphone level back, returning
    /// the state that was cleared. ``close()`` calls it too: the mixer is
    /// process-wide, so a session that ended mid-stream must not leave the next
    /// one muted. Teardown needs only the level — the room is going away.
    @discardableResult
    nonisolated func stopAudioStreamSlot() -> AudioStreamState? {
        let state = audioStreamLock.withLock { current -> AudioStreamState? in
            guard let s = current else { return nil }
            current = nil
            return s
        }
        guard let state else { return nil }
        AudioManager.shared.mixer.micVolume = state.restoreMicVolume
        Self.audioStreamLog.info("audio stream stopped, microphone restored")
        return state
    }
}
