import LiveKit

extension RealtimeSession {

    /// Pre-warm the OS audio engine so the mic publish on the next
    /// ``start(_:config:micMuted:)`` doesn't pay a cold start-up. Best-effort;
    /// silently no-ops when mic permission isn't yet authorized, so gate the
    /// call on the platform permission state. Applies ``audioProcessingOptions``
    /// so the warmed engine is already configured the same way the session's
    /// own capture will be — an unmatched warm would stand up one processing
    /// pipeline and then reconfigure to another the moment the session
    /// actually publishes, which is its own audible glitch independent of
    /// which pipeline either one uses.
    static func setRecordingAlwaysPrepared(_ enabled: Bool) async throws {
        try await AudioManager.shared.setRecordingAlwaysPreparedMode(
            enabled, audioProcessingOptions: audioProcessingOptions
        )
    }

    /// The mode Cosmo requests for each voice-processing component, applied
    /// everywhere the mic is touched — the warm (above) and the session's own
    /// capture (``makeSessionRoom()``'s ``RoomOptions/defaultAudioCaptureOptions``)
    /// — so the two never disagree.
    ///
    /// On macOS this forces WebRTC's own software echo cancellation / gain
    /// control / noise suppression instead of Apple's platform Voice
    /// Processing I/O (the SDK's own ``EchoCancellationMode/automatic``
    /// default prefers platform processing whenever it's available, which on
    /// macOS is always). A live platform VPIO unit takes over the *shared
    /// system audio device*: it reroutes every app's output — not just
    /// Cosmo's — through the voice-comm path for as long as it's engaged,
    /// which is what made a bare notch hover audibly duck unrelated playback
    /// (fixed by not warming on hover at all) and still ducks/dims playback
    /// for the full duration of any genuine session (Talk press, dictation,
    /// Learn An App) — a cost inherent to the platform unit, not any one
    /// feature's wiring, so it can't be fixed by tuning any one feature.
    /// Software processing is in-process DSP over already-captured samples;
    /// it never touches the device route, so unrelated playback is never
    /// touched either — this is the actual fix, not `duckingLevel` tuning,
    /// which only ever narrowed how much platform VPIO ducks, not whether it
    /// takes the device over in the first place.
    static var audioProcessingOptions: AudioProcessingOptions {
        #if os(macOS)
        AudioProcessingOptions(
            echoCancellationMode: .software,
            autoGainControlMode: .software,
            noiseSuppressionMode: .software
        )
        #else
        AudioProcessingOptions()
        #endif
    }

    /// ``audioProcessingOptions``, in the shape ``RoomOptions/defaultAudioCaptureOptions``
    /// takes at track-creation time. Two types because LiveKit asks for the
    /// same three modes through two different APIs, not two different
    /// policies — keep both in sync with ``audioProcessingOptions``.
    static var audioCaptureOptions: AudioCaptureOptions {
        #if os(macOS)
        AudioCaptureOptions(
            echoCancellationMode: .software,
            autoGainControlMode: .software,
            noiseSuppressionMode: .software
        )
        #else
        AudioCaptureOptions()
        #endif
    }

    #if os(iOS)
    /// Toggle LiveKit's automatic `AVAudioSession` management. When disabled,
    /// the host app is the sole owner of the session: LiveKit no longer
    /// configures the category/mode/route or activates/deactivates it around a
    /// connect, so the app's own `.playAndRecord`/`.voiceChat` configuration is
    /// the one in force when the mic's voice-processing (VPIO) echo canceller
    /// comes up. Set once before the first ``start(_:config:)``. iOS-only —
    /// macOS has no `AVAudioSession`.
    public static func setAutomaticAudioSessionManagement(enabled: Bool) {
        AudioManager.shared.audioSession.isAutomaticConfigurationEnabled = enabled
    }
    #endif
}
