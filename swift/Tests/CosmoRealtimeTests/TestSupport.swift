import AVFAudio
import CoreMedia
import Foundation
import os
@testable import CosmoRealtime

// MARK: - Fake transport

/// In-memory ``SessionTransport``: records every frame the session
/// hands it (the serialized ``session-config`` plus all sends) and
/// lets tests inject raw server frames through the same ``onFrame``
/// path the LiveKit transport uses.
actor FakeSessionTransport: SessionTransport {
    private(set) var sent: [Data] = []
    private(set) var micEnabled: Bool?
    private(set) var connectedMicMuted: Bool?
    private(set) var registeredToolHandlers: [String: ClientToolHandler] = [:]
    private(set) var registeredBackgroundToolHandlers: [String: BackgroundClientToolHandler] = [:]
    private(set) var clientToolJobSink: ClientToolJobSink?
    private var callbacks: SessionTransportCallbacks?
    private var scriptedRejection: SessionStartFailure?
    private var scriptedMicError: Error?
    private var scriptedSendError: Error?

    /// Start response the fake reports; ``timings`` stays nil so tests that
    /// care about the server breakdown opt in by overriding it. Lock-backed
    /// so the nonisolated ``connectTimings`` can read it.
    nonisolated let startResponseBox = OSAllocatedUnfairLock(
        initialState: RealtimeSessionResponse(
            livekitUrl: "ws://fake.invalid",
            roomName: "trace-room",
            sessionId: "trace-session",
            token: "trace-token"
        )
    )

    func setStartResponse(_ response: RealtimeSessionResponse) {
        startResponseBox.withLock { $0 = response }
    }

    func scriptRejection(_ failure: SessionStartFailure) {
        scriptedRejection = failure
    }

    func scriptMicError(_ error: Error) {
        scriptedMicError = error
    }

    /// Fail the next wire send — the path ``setMuted`` rides, so a test can
    /// refuse the mute gate without touching the microphone.
    func scriptSendError(_ error: Error) {
        scriptedSendError = error
    }

    func connect(
        configFrame: Data,
        callbacks: SessionTransportCallbacks,
        clientToolHandlers: [String: ClientToolHandler],
        backgroundClientToolHandlers: [String: BackgroundClientToolHandler],
        clientToolJobSink: ClientToolJobSink?,
        hooks: HookEngine?,
        micMuted: Bool
    ) async throws -> SessionStartInfo {
        sent.append(configFrame)
        connectedMicMuted = micMuted
        // The real transport publishes the microphone during the join unless
        // the session asked to start muted (``ConnectOptions.enableMicrophone``).
        micEnabled = !micMuted
        if let scriptedRejection {
            throw scriptedRejection
        }
        self.callbacks = callbacks
        self.registeredToolHandlers = clientToolHandlers
        self.registeredBackgroundToolHandlers = backgroundClientToolHandlers
        self.clientToolJobSink = clientToolJobSink
        return SessionStartInfo(response: startResponseBox.withLock { $0 })
    }

    func send(frame: Data) async throws {
        if let scriptedSendError {
            self.scriptedSendError = nil
            throw scriptedSendError
        }
        sent.append(frame)
    }

    private(set) var sentBytes: [(data: Data, topic: String)] = []
    func sendBytes(_ data: Data, topic: String) async throws {
        sentBytes.append((data, topic))
    }

    func setMicrophoneEnabled(_ enabled: Bool) async throws {
        if let scriptedMicError {
            throw scriptedMicError
        }
        micEnabled = enabled
    }

    func close() async {}

    // No test exercises audio levels; an empty finished stream satisfies
    // the protocol and keeps the suite compiling.
    nonisolated let inputLevels: AsyncStream<Float> = AsyncStream { $0.finish() }
    nonisolated let outputLevels: AsyncStream<Float> = AsyncStream { $0.finish() }

    // No test exercises screen share through this fake, so these stubs
    // only satisfy the protocol and keep the suite compiling.
    private(set) var screenShareStarted = false

    func startScreenShare() async throws { screenShareStarted = true }
    nonisolated func pushScreenShareFrame(_ sampleBuffer: CMSampleBuffer) {}
    func stopScreenShare() async { screenShareStarted = false }
    nonisolated func setScreenShareFrameProcessor(_ processor: ScreenShareFrameProcessor?) {}
    nonisolated func onScreenShareFailed(_ handler: @escaping @Sendable (Error) -> Void) -> Cancellable {
        Cancellable {}
    }

    // No test exercises video streams through this fake either.
    private(set) var videoStreamActive = false

    func addVideoStream() async throws -> VideoStreamHandle {
        videoStreamActive = true
        return VideoStreamHandle(streamID: UUID()) { _ in }
    }
    func removeVideoStream(_ handle: VideoStreamHandle) async { videoStreamActive = false }

    private(set) var audioStreamActive = false
    /// Mirrors the real transport: the stream publishes the local audio track,
    /// and stopping puts back whatever was there before.
    private var micWasPublishingBeforeStream = false

    func startAudioStream() async throws {
        micWasPublishingBeforeStream = micEnabled ?? false
        try await setMicrophoneEnabled(true)
        audioStreamActive = true
    }
    nonisolated func pushAudioBuffer(_ buffer: AVAudioPCMBuffer) {}
    @discardableResult
    func stopAudioStream() async -> Bool {
        guard audioStreamActive else { return false }
        audioStreamActive = false
        guard micWasPublishingBeforeStream else {
            try? await setMicrophoneEnabled(false)
            return false
        }
        return true
    }

    // The fake measures no connect phases; server timings ride the start
    // response, so tests that care set them via ``setStartResponse``.
    nonisolated var connectTimings: SessionConnectTimings {
        SessionConnectTimings(
            wsMs: nil, roomMs: nil, micMs: nil, totalConnectMs: nil,
            serverTimings: startResponseBox.withLock { $0.timings }
        )
    }

    /// Deliver one raw server frame, awaiting the session's handling so
    /// injection order is processing order.
    func simulateClose(_ reason: RealtimeSession.EndReason) async {
        await callbacks?.onClosed(reason)
    }

    func inject(_ data: Data) async {
        await callbacks?.onFrame(data)
    }

    /// Fire the agent-track readiness signal (what the LiveKit transport calls
    /// when the agent publishes its track), so tests can exercise readiness
    /// without a real room.
    func signalAgentLive() async {
        await callbacks?.onAgentLive()
    }
}

// MARK: - Observation

/// One SDK-emitted event (or sent frame) normalized to the wire
/// vocabulary: the wire ``type`` discriminator plus the JSON fields.
struct ObservedEvent: Sendable {
    let type: String
    let fields: [String: JSONValue]
}

func observeSentFrame(_ data: Data) -> ObservedEvent {
    guard case .object(let fields)? = try? JSONDecoder().decode(JSONValue.self, from: data) else {
        return ObservedEvent(type: "<unparseable>", fields: [:])
    }
    guard case .string(let type)? = fields["type"] else {
        return ObservedEvent(type: "<untyped>", fields: fields)
    }
    return ObservedEvent(type: type, fields: fields)
}

// MARK: - Waiting

func waitUntil(deadline: TimeInterval, _ condition: @Sendable () -> Bool) async {
    let end = Date().addingTimeInterval(deadline)
    while !condition() && Date() < end {
        try? await Task.sleep(nanoseconds: 10_000_000)
    }
}
