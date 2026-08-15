import AVFAudio
import CoreMedia
import CosmoRealtimeAPI
import Foundation

/// Internal name for the generated session-start response. Not public: the
/// session surfaces ``RealtimeSession/sessionId`` and
/// ``RealtimeSession/connectTimings`` from it instead of handing out the join
/// credentials the transport already spent.
typealias RealtimeSessionResponse =
    CosmoRealtimeAPI.Components.Schemas.SessionResponse

/// Result of a successful transport-level session start.
struct SessionStartInfo: Sendable {
    let response: RealtimeSessionResponse

    var sessionId: String { response.sessionId }
}

/// Typed start failures a transport can raise from
/// ``SessionTransport/connect(configFrame:callbacks:)``.
/// ``RealtimeSession`` maps them onto ``RealtimeSessionError`` and the
/// terminal lifecycle state.
enum SessionStartFailure: Error, Sendable {
    /// The server refused the session (HTTP rejection or a scripted
    /// handshake ``error`` frame). ``status`` is the HTTP status of the
    /// rejection when it came from a real REST verdict (nil for a scripted
    /// handshake-frame rejection); ``code`` is the protocol error code when
    /// one could be extracted (e.g. ``"version_mismatch"``).
    case rejected(status: Int?, code: String?, detail: String)
    /// The start never reached a server verdict (network failure,
    /// timeout, malformed success payload).
    case transport(message: String)
    /// The credential could not be resolved before the request went out —
    /// a ``TokenSource`` fetch failed in the auth middleware. Carried
    /// un-erased so ``RealtimeSession`` can rethrow the ``MintTokenError``
    /// (and its slug) to the ``start`` caller, matching the other SDKs.
    case credential(MintTokenError)
}

/// How a transport reports asynchronous activity back to the session.
/// All closures hop onto the session actor; the transport must deliver
/// ``onFrame`` calls in wire arrival order (awaiting each call before
/// the next preserves it).
struct SessionTransportCallbacks: Sendable {
    let onFrame: @Sendable (Data) async -> Void
    let onClosed: @Sendable (RealtimeSession.EndReason) async -> Void
    let onReconnecting: @Sendable () async -> Void
    let onReconnected: @Sendable () async -> Void
    /// The agent participant published a media track — LiveKit's race-free
    /// "agent is live" signal, independent of the server ``ready`` data frame.
    /// Fired at most once per session. Lets the session latch readiness even
    /// when the broadcast ``ready`` frame is lost to the pre-data-channel race
    /// (published before this client's data channel was up, never replayed).
    /// A transport with no participant model (the contract-trace fake) simply
    /// never calls it; readiness then rides the ``ready`` frame as before.
    let onAgentLive: @Sendable () async -> Void
}

/// Protocol-agnostic transport under ``RealtimeSession``: carries
/// opaque JSON frames both ways and owns the audio path. Production is
/// ``LiveKitSessionTransport``; the contract-trace suite drives the
/// session through an in-memory fake.
protocol SessionTransport: Sendable {
    /// Start the session: deliver ``configFrame`` (the serialized
    /// ``session-config``) to the server and bring up the media
    /// transport. ``clientToolHandlers`` are the local handlers the agent
    /// drives over the transport (LiveKit RPC), keyed by tool name.
    /// Returns once the transport is live; server events then flow through
    /// ``callbacks.onFrame``.
    ///
    /// When ``micMuted`` is `true` the transport joins WITHOUT publishing
    /// the microphone — nothing is captured or sent until the first
    /// ``setMicrophoneEnabled(true)``. Privacy contract: a session the host
    /// presents as "muted" must never stream audio during the connect
    /// window (the agent is already in the room by then).
    func connect(
        configFrame: Data,
        callbacks: SessionTransportCallbacks,
        clientToolHandlers: [String: ClientToolHandler],
        backgroundClientToolHandlers: [String: BackgroundClientToolHandler],
        clientToolJobSink: ClientToolJobSink?,
        hooks: HookEngine?,
        micMuted: Bool
    ) async throws -> SessionStartInfo
    /// Publish one already-chunked wire packet, in order.
    func send(frame: Data) async throws
    /// Stream raw bytes to the agent on a named ``topic``, out of band from
    /// the JSON control channel — for large binary client-tool payloads (a
    /// screenshot + accessibility dump, etc.). Delivered only to the agent
    /// participant.
    func sendBytes(_ data: Data, topic: String) async throws
    /// Toggle microphone capture. For a muted join this is where the mic
    /// first publishes, so it can throw (e.g. denied capture permission);
    /// ``RealtimeSession/setMuted(_:)`` surfaces that rather than reporting a
    /// false success while no track is published.
    func setMicrophoneEnabled(_ enabled: Bool) async throws
    /// Tear down the media transport. Idempotent.
    func close() async

    // MARK: Audio levels

    /// Per-buffer microphone RMS (0…1), latest-value: a slow consumer
    /// drops intermediate samples rather than accumulating them. Yields
    /// while a local audio track is published; finishes at ``close()``.
    nonisolated var inputLevels: AsyncStream<Float> { get }
    /// Per-buffer agent-audio RMS (0…1), latest-value like
    /// ``inputLevels``. Yields while the remote agent audio track is
    /// subscribed; finishes at ``close()``.
    nonisolated var outputLevels: AsyncStream<Float> { get }

    /// Set software playback gain (0…1) for the agent's audio: `0` mutes,
    /// `1` is unity. Applied to the subscribed agent track and re-applied
    /// when a later track attaches. Default no-op (see the extension) — only
    /// the production LiveKit transport attenuates a real track.
    nonisolated func setAgentPlaybackVolume(_ volume: Double)

    // MARK: Screen share

    /// Begin a screen-share publish. Creates the video track immediately
    /// but defers the SFU publish until the first
    /// ``pushScreenShareFrame`` arrives, since the capturer cannot
    /// resolve frame dimensions before one sample buffer is captured.
    /// Idempotent: any prior share is stopped first.
    func startScreenShare() async throws
    /// Push one captured frame into the active screen-share publish.
    /// Safe to call from a capture thread. The first call triggers the
    /// deferred publish; later calls feed the publishing track. No-op
    /// when no share is active.
    nonisolated func pushScreenShareFrame(_ sampleBuffer: CMSampleBuffer)
    /// Stop the active screen-share publish. Idempotent.
    func stopScreenShare() async
    /// Install or clear a frame processor run inside
    /// ``pushScreenShareFrame`` before each frame reaches the capturer.
    /// Pass ``nil`` to remove a previously-installed processor.
    nonisolated func setScreenShareFrameProcessor(_ processor: ScreenShareFrameProcessor?)
    /// Register a callback fired when the deferred screen-share publish
    /// fails (SFU rejection, codec mismatch, network blip). Share state
    /// is cleared before the callback fires, so the handler may restart
    /// the share. Returns a ``Cancellable`` to drop the listener.
    nonisolated func onScreenShareFailed(_ handler: @escaping @Sendable (Error) -> Void) -> Cancellable

    // MARK: Video streams

    /// Begin a non-screen video publish (camera, file, any pixels-only
    /// stream) and return its pushable handle, on the same
    /// deferred-publish contract as ``startScreenShare``. One video
    /// publish at a time: throws
    /// ``RealtimeSessionError/videoPublishAlreadyActive`` while any
    /// video publish is live.
    func addVideoStream() async throws -> VideoStreamHandle
    /// Remove a video stream added by ``addVideoStream``. Identity-keyed
    /// and idempotent: a stale handle is a no-op.
    func removeVideoStream(_ handle: VideoStreamHandle) async

    // MARK: Audio streams

    /// Take the session's voice for a caller-owned audio publish. Publishes
    /// the local audio track if it is not already publishing and silences the
    /// device microphone for the duration, so the agent hears exactly the
    /// pushed buffers. Throws
    /// ``RealtimeSessionError/audioPublishAlreadyActive`` while one is running.
    func startAudioStream() async throws
    /// Push one buffer into the running stream; inert when none is.
    nonisolated func pushAudioBuffer(_ buffer: AVAudioPCMBuffer)
    /// Put back what the stream displaced, reporting whether the microphone
    /// holds the voice afterwards. Idempotent.
    @discardableResult
    func stopAudioStream() async -> Bool

    // MARK: Connect timings

    /// Connect-latency breakdown: the client-measured connect phases plus
    /// the server's own session-start timings.
    nonisolated var connectTimings: SessionConnectTimings { get }
}

extension SessionTransport {
    /// Transports without a real audio path (the contract-trace fake) have
    /// nothing to attenuate, so playback gain is a no-op for them.
    nonisolated func setAgentPlaybackVolume(_ volume: Double) {}
}
