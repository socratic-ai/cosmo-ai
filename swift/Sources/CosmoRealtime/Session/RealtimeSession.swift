import CoreGraphics
import CosmoRealtimeAPI
import Foundation
import OpenAPIRuntime
import os

/// A live realtime voice session speaking the published developer
/// protocol. One call starts it; consumption is a single typed event
/// stream:
///
/// ```swift
/// let session = try await RealtimeSession.start(
///     .init(apiKey: "key"),
///     config: SessionConfig(instructions: "You are a terse assistant.")
/// )
/// for try await event in session.events {
///     switch event {
///     case .ready(let ready): print("live, session:", ready.sessionId)
///     case .transcript(let delta): print(delta.text)
///     case .sessionEnded(let ended): print("over:", ended.reason ?? "")
///     case .unknown(let rawType, _): print("unrecognized event:", rawType ?? "?")
///     default: break
///     }
/// }
/// ```
///
/// Single-attempt: a session that ends — by ``end()``, by the server's
/// ``session-ended``, or by a transport failure — is terminal. Start a new
/// one to reconnect.
///
/// ``events`` is single-consumer: iterate it from exactly one task.
public actor RealtimeSession {

    static let log = Logger(subsystem: CosmoRealtimeLog.subsystem, category: "session")

    /// Package name, sent with ``sdkVersion`` as the SDK identity on every
    /// Cosmo REST call.
    public static let sdkName = "cosmo-swift-sdk"

    /// Package version, sent as the SDK identity on every Cosmo REST call
    /// and on the ``session-config`` start payload.
    public static let sdkVersion = "0.6.0"

    /// The ``X-Cosmo-SDK`` header value carried on every Cosmo REST call.
    static let sdkIdentityHeaderValue = "\(sdkName)/\(sdkVersion)"

    /// Hard ceiling on a base64 image payload, mirroring the server-side
    /// ingress bound (`_MAX_IMAGE_B64_LEN`) so a frame the server would refuse
    /// never leaves the client — and never gets chunked across the control
    /// channel on its way to being refused.
    public static let maxImageBase64Length = 12_000_000

    /// Payload size at which a frame is decoded to check its pixel dimensions.
    ///
    /// The bound we care about is on pixels, but reading pixels means decoding,
    /// and decoding every frame would tax callers who are already well-behaved.
    /// This floor is set so a compliant frame is forwarded without a decode
    /// while an over-resolution one still gets inspected: a 2704x1756 desktop
    /// screenshot measured 165K base64 chars at 1280px and 295K at 1920px.
    /// Calibrated on desktop UI content — photographic or noisy frames compress
    /// far worse and may cross it while already within the pixel bound, which
    /// costs them one decode and no re-encode.
    static let imageBase64InspectThreshold = 200_000

    /// A caller streaming stills re-encodes every frame; warn once, not 3,600
    /// times an hour.
    private var didWarnImageReencode = false

    // MARK: Options

    /// Client-level settings: credentials, endpoints, and timeouts.
    public struct Options: Sendable {
        /// The session credential. Exactly one form, chosen at construction.
        public enum Credential: Sendable, Equatable, CustomStringConvertible, CustomDebugStringConvertible {
            /// Workspace-scoped key — server-side only. Opens sessions and
            /// can mint end-user tokens. Never embed this in a distributed
            /// client.
            case apiKey(String)
            /// A minted per-user JWT — scoped to one external user, safe to
            /// embed in a device or browser. Opens sessions but cannot mint.
            case token(String)
            /// A ``TokenSource`` that fetches — and keeps fresh — a minted
            /// per-user JWT itself, so a distributed app never handles
            /// refresh. Opens sessions but cannot mint.
            case tokenSource(TokenSource)

            /// The bearer value sent on the ``Authorization`` header — for a
            /// ``tokenSource(_:)`` credential, the source's current JWT
            /// (fetched or refreshed as needed).
            func bearerToken() async throws -> String {
                switch self {
                case .apiKey(let v), .token(let v): return v
                case .tokenSource(let source): return try await source.jwt()
                }
            }

            public static func == (lhs: Credential, rhs: Credential) -> Bool {
                switch (lhs, rhs) {
                case (.apiKey(let l), .apiKey(let r)): return l == r
                case (.token(let l), .token(let r)): return l == r
                case (.tokenSource(let l), .tokenSource(let r)): return l === r
                default: return false
                }
            }

            public var description: String {
                switch self {
                case .apiKey: return "Credential.apiKey(•••)"
                case .token: return "Credential.token(•••)"
                case .tokenSource: return "Credential.tokenSource(•••)"
                }
            }
            public var debugDescription: String { description }
        }

        public var credential: Credential
        /// The Cosmo API origin: the `baseURL` passed at construction, else
        /// `COSMO_BASE_URL`, else production. Fixed once the options are
        /// built, so one session talks to one backend and a stored
        /// credential cannot be sent somewhere it was not issued for.
        public internal(set) var baseURL: URL
        /// Timeout for the media-transport join (signaling + ICE).
        public var connectTimeout: TimeInterval
        /// Timeout for the REST session-start request. Sized separately
        /// from ``connectTimeout`` because session provisioning is
        /// bounded by the backend's agent dispatch.
        public var requestTimeout: TimeInterval
        /// Defaults merged under each per-call config (per-call values
        /// win field by field).
        /// TLS verification for the REST session-start call. ``.auto`` (default)
        /// skips verification only for loopback hosts so a self-signed local-dev
        /// backend works; remote hosts are always verified.
        public var verifyTLS: VerifyTLS

        /// `true` only for a ``Credential/apiKey(_:)`` credential — a
        /// minted ``Credential/token(_:)`` (or the ``Credential/tokenSource(_:)``
        /// that fetches one) cannot mint further tokens.
        public var canMint: Bool {
            if case .apiKey = credential { return true }
            return false
        }

        /// The bearer value for this options' credential — awaited per
        /// request so a ``Credential/tokenSource(_:)`` can refresh.
        func bearerToken() async throws -> String {
            try await credential.bearerToken()
        }

        /// ``baseURL`` defaults to ``RealtimeBaseURL/resolve()`` — the
        /// environment override, else production. Pass one explicitly when the
        /// credential itself names the backend that issued it: a stored or
        /// minted credential is only valid against that origin, and resolving
        /// from the environment would send its session start elsewhere.
        public init(
            credential: Credential,
            baseURL: URL? = nil,
            connectTimeout: TimeInterval = 30,
            requestTimeout: TimeInterval = 45,
            verifyTLS: VerifyTLS = .auto
        ) {
            self.credential = credential
            self.baseURL = baseURL ?? RealtimeBaseURL.resolve()
            self.connectTimeout = connectTimeout
            self.requestTimeout = requestTimeout
            self.verifyTLS = verifyTLS
        }

        /// Convenience: a workspace api-key credential.
        public init(
            apiKey: String,
            baseURL: URL? = nil,
            connectTimeout: TimeInterval = 30,
            requestTimeout: TimeInterval = 45,
            verifyTLS: VerifyTLS = .auto
        ) {
            self.init(
                credential: .apiKey(apiKey),
                baseURL: baseURL,
                connectTimeout: connectTimeout,
                requestTimeout: requestTimeout,
                verifyTLS: verifyTLS
            )
        }

        /// Convenience: a minted per-user JWT credential.
        public init(
            token: String,
            baseURL: URL? = nil,
            connectTimeout: TimeInterval = 30,
            requestTimeout: TimeInterval = 45,
            verifyTLS: VerifyTLS = .auto
        ) {
            self.init(
                credential: .token(token),
                baseURL: baseURL,
                connectTimeout: connectTimeout,
                requestTimeout: requestTimeout,
                verifyTLS: verifyTLS
            )
        }

        /// Convenience: a self-refreshing ``TokenSource`` credential.
        public init(
            tokenSource: TokenSource,
            baseURL: URL? = nil,
            connectTimeout: TimeInterval = 30,
            requestTimeout: TimeInterval = 45,
            verifyTLS: VerifyTLS = .auto
        ) {
            self.init(
                credential: .tokenSource(tokenSource),
                baseURL: baseURL,
                connectTimeout: connectTimeout,
                requestTimeout: requestTimeout,
                verifyTLS: verifyTLS
            )
        }

        /// Zero-argument construction: the SDK resolves an API key itself —
        /// `COSMO_API_KEY` from the environment, else the `cosmo login`
        /// credentials file (`COSMO_CREDENTIALS_FILE` or
        /// `~/.cosmo/credentials`, profile from `COSMO_PROFILE`). A file
        /// credential brings its own `base_url` along, since a stored key is
        /// only valid against the backend that issued it. Throws
        /// ``CredentialsError`` when nothing resolves, the file is unusable,
        /// or the stored key expired.
        public init(
            connectTimeout: TimeInterval = 30,
            requestTimeout: TimeInterval = 45,
            verifyTLS: VerifyTLS = .auto
        ) throws {
            try self.init(
                environment: ProcessInfo.processInfo.environment,
                connectTimeout: connectTimeout,
                requestTimeout: requestTimeout,
                verifyTLS: verifyTLS
            )
        }

        /// The resolving init against a supplied environment; internal so
        /// tests can inject one without mutating the process environment.
        init(
            environment: [String: String],
            connectTimeout: TimeInterval = 30,
            requestTimeout: TimeInterval = 45,
            verifyTLS: VerifyTLS = .auto
        ) throws {
            let resolved = try CredentialsFile.resolveFromRuntime(environment: environment)
            self.init(
                credential: .apiKey(resolved.apiKey),
                connectTimeout: connectTimeout,
                requestTimeout: requestTimeout,
                verifyTLS: verifyTLS
            )
            if let base = resolved.baseURL {
                var raw = base
                while raw.hasSuffix("/") { raw.removeLast() }
                guard let url = URL(string: raw), url.scheme != nil else {
                    throw CredentialsError.fileInvalid(
                        "The resolved base_url is not a URL: \(base). Run: cosmo login"
                    )
                }
                self.baseURL = url
            }
        }
    }

    // MARK: Lifecycle vocabulary

    /// Transport-level lifecycle, observable via ``states``. Distinct
    /// from the application-level ``Event/ready(_:)`` event.
    @frozen
    public enum State: Sendable, Equatable {
        case idle
        case connecting
        case connected
        /// The transport is recovering from a transient drop; the
        /// session survives if it succeeds.
        case reconnecting
        /// Recovery succeeded — same session, same thread.
        case reconnected
        /// Terminal. The ``events`` stream is finished.
        case disconnected(reason: EndReason)
    }

    /// Why a session reached ``State/disconnected(reason:)``.
    @frozen
    public enum EndReason: Sendable, Equatable {
        /// This client called ``end()``.
        case clientEnded
        /// This client tore down without the wire ``end`` frame.
        case clientClosed
        /// The server refused the session start. ``status`` is the HTTP
        /// status of the rejection when it came from a real REST verdict
        /// (nil for a scripted handshake-frame rejection).
        case handshakeFailed(status: Int?, detail: String?)
        /// The server ended the session gracefully (the
        /// ``Event/sessionEnded(_:)`` event carries the reason).
        case serverEnded(reason: String?)
        /// The transport failed.
        case transportError(message: String)
    }

    private enum Lifecycle {
        case idle
        case connecting
        case connected
        case reconnecting
        case closed
    }

    // MARK: State

    // Read by the screen-share extension (forwards onto the transport,
    // which owns the screen-share state); only assigned in ``init``.
    let transport: any SessionTransport
    // Client-level settings retained for post-start REST calls that reuse the
    // session's backend, credential, and TLS policy (e.g. ``dial``). ``nil``
    // when the session was constructed directly over a fake transport in tests.
    let options: Options?
    // Built on the first out-of-band REST read and kept, so polling a session
    // does not stand up a URLSession per call.
    var restClient: RealtimeClient?
    private let reassembler = EnvelopeReassembler()
    private var lifecycle: Lifecycle = .idle
    private var hooks: HookEngine?
    // Reason latched from the server's best-effort ``session-ended`` frame;
    // consulted only on the unsolicited transport-close path.
    private var serverEndReason: String?
    private var serverEndGraceTask: Task<Void, Never>?
    /// Grace between a ``session-ended`` frame and a forced teardown when the
    /// expected transport close never follows. Per-session so a test can shorten
    /// its own without reaching into every other session in the process.
    let serverEndGraceNanos: UInt64
    static let defaultServerEndGraceNanos: UInt64 = 5_000_000_000
    /// Last mute state this client asserted; re-asserted on reconnect the same
    /// way the input binding is.
    private var lastSetMuted: Bool?
    // Owns background client-tool jobs (a BackgroundClientTool acks fast + delivers
    // later); cancelled on teardown so in-flight jobs don't outlive the session.
    private var clientToolJobSink: ClientToolJobSink?

    /// The session-start response. Held whole so a new server field is
    /// decoded rather than dropped, but surfaced field by field — the join
    /// credentials on it are spent by the transport and the token has no
    /// business on a public accessor.
    private var startResponse: RealtimeSessionResponse?

    /// Server-minted session identifier, set once the start succeeds.
    public var sessionId: String? { startResponse?.sessionId }



    /// Typed server events in arrival order. Every terminal path of a live
    /// session — graceful ``end()``, server teardown, or a transport drop —
    /// ends with a locally synthesized ``Event/sessionEnded(_:)`` as the
    /// final element, after which the sequence finishes; the stream does
    /// **not** throw (the underlying transport cannot distinguish a clean
    /// server close from an abnormal drop, so neither does the stream). The
    /// terminal reason is on ``Event/SessionEnded/reason`` and on
    /// ``states`` (``State/disconnected(reason:)``). Start failures throw
    /// from ``start(_:config:)`` instead. Single consumer.
    public nonisolated let events: AsyncThrowingStream<Event, Error>
    private nonisolated let eventsContinuation: AsyncThrowingStream<Event, Error>.Continuation

    /// Transport lifecycle updates. Yields ``State/idle`` on creation
    /// and finishes after the terminal ``State/disconnected(reason:)``.
    public nonisolated let states: AsyncStream<State>
    private nonisolated let statesContinuation: AsyncStream<State>.Continuation

    /// Fires once when the agent participant publishes a track — LiveKit's
    /// race-free liveness signal, distinct from the wire ``Event/ready(_:)``
    /// frame and deliberately not a substitute for it: only ``ready`` carries
    /// the session id, the rejected-tool list, and the effective duration cap.
    ///
    /// Use it to drive a "connecting…" spinner without gating that spinner on
    /// a data frame. Prefer ``waitUntilAgentLive()`` unless you need the
    /// stream. The wire-facing ``events`` stream is unchanged — this never
    /// fabricates a ``ready`` event on it.
    public nonisolated let agentLive: AsyncStream<Void>
    private nonisolated let agentLiveContinuation: AsyncStream<Void>.Continuation
    private var didSignalAgentLive = false

    /// Tasks parked in ``waitUntilEnded()``, all resumed once by ``_close``.
    private var endWaiters: [CheckedContinuation<Void, Never>] = []

    /// Tasks parked in ``waitUntilAgentLive()``. Resumed by the agent-track
    /// signal, or by ``_close`` so a session that dies first never hangs them.
    private var agentLiveWaiters: [CheckedContinuation<Void, Never>] = []

    /// Resource teardown bound to this session's lifetime, run once by
    /// ``_close`` before any end-waiter wakes.
    private var onClose: (@Sendable () async -> Void)?

    /// Bind teardown to this session's close. Runs once — immediately if the
    /// session has already closed.
    func _attachOnClose(_ handler: @escaping @Sendable () async -> Void) async {
        if case .closed = lifecycle {
            await handler()
            return
        }
        onClose = handler
    }

    // MARK: Audio levels

    /// Microphone RMS level (0…1), latest-value (a slow consumer drops
    /// intermediate samples). Yields while the local audio track is
    /// published and the consumer iterates; finishes when the session
    /// ends. Render-callback driven by the transport — no timer.
    public nonisolated var inputLevels: AsyncStream<Float> {
        transport.inputLevels
    }

    /// Agent audio RMS level (0…1), latest-value like ``inputLevels``.
    /// Yields while the remote agent audio track is subscribed; finishes
    /// when the session ends.
    public nonisolated var outputLevels: AsyncStream<Float> {
        transport.outputLevels
    }

    /// Software playback gain for the agent's audio: `0` mutes, `1` is unity.
    /// Values outside 0…1 are clamped. Takes effect immediately on the current
    /// agent track and is re-applied to any track that attaches later (late
    /// agent join, reconnect).
    ///
    /// Voice sessions live in iOS's call-volume domain, whose hardware slider
    /// bottoms out *above* silence (a call can't be rocker-muted). A host that
    /// wants "slider at the floor = silent" observes `AVAudioSession.outputVolume`
    /// and drives this.
    public nonisolated func setAgentPlaybackVolume(_ volume: Double) {
        transport.setAgentPlaybackVolume(volume)
    }

    // MARK: Connect timings

    /// Connect-latency breakdown: the client-measured connect phases plus
    /// the server's own session-start timings. Safe to read once the start
    /// completes. Sink-agnostic — the SDK does not report it anywhere.
    public nonisolated var connectTimings: SessionConnectTimings {
        transport.connectTimings
    }

    // MARK: Init + start

    init(
        transport: any SessionTransport,
        options: Options? = nil,
        serverEndGraceNanos: UInt64 = defaultServerEndGraceNanos
    ) {
        self.transport = transport
        self.options = options
        self.serverEndGraceNanos = serverEndGraceNanos
        let eventStream = AsyncThrowingStream<Event, Error>.makeStream(bufferingPolicy: .unbounded)
        self.events = eventStream.stream
        self.eventsContinuation = eventStream.continuation
        let stateStream = AsyncStream<State>.makeStream(bufferingPolicy: .bufferingNewest(64))
        self.states = stateStream.stream
        self.statesContinuation = stateStream.continuation
        let agentLiveStream = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
        self.agentLive = agentLiveStream.stream
        self.agentLiveContinuation = agentLiveStream.continuation
        self.statesContinuation.yield(.idle)
    }

    /// The transport observed the agent publish its track. Signal readiness
    /// once (idempotent); the app wrapper latches on it. Never yields on the
    /// wire-facing ``events`` stream, so the external-protocol contract is
    /// unchanged.
    private func _agentBecameLive() {
        guard !didSignalAgentLive else { return }
        didSignalAgentLive = true
        Self.log.info("realtime.agent_track_observed — readiness signalled from track (ready frame independent)")
        agentLiveContinuation.yield(())
        let waiters = agentLiveWaiters
        agentLiveWaiters = []
        for waiter in waiters { waiter.resume() }
    }

    /// Start a session: one REST session-start + media-transport join.
    /// Returns once the transport is live; await ``Event/ready(_:)`` on
    /// ``events`` for the agent-ready signal.
    /// - Parameter micMuted: when `true`, the session joins WITHOUT
    ///   publishing the microphone — nothing is captured or sent until the
    ///   first ``setMuted(false)``. A session the host presents as "muted"
    ///   must never stream audio during the connect window.
    /// - Parameter rpcHandlers: client-tool handlers registered by method name
    ///   but **not** advertised to the agent — for server-orchestrated tools the
    ///   server invokes over RPC directly (never chosen from the tool list).
    ///   Advertised-and-handled tools belong in ``SessionConfig/tools`` as a
    ///   ``SessionConfig/Tool/client(name:description:parameters:handler:)``;
    ///   these are the register-only complement. On a name collision the
    ///   ``rpcHandlers`` entry wins.
    public static func start(
        _ options: Options,
        config: SessionConfig = SessionConfig(),
        micMuted: Bool = false,
        rpcHandlers: [String: ClientToolHandler] = [:]
    ) async throws -> RealtimeSession {
        guard Self.isSecureBaseURL(options.baseURL) else {
            throw RealtimeSessionError.insecureBaseURL(options.baseURL.absoluteString)
        }
        let session = RealtimeSession(
            transport: LiveKitSessionTransport(options: options), options: options
        )
        try await session._start(
            config: config,
            micMuted: micMuted,
            rpcHandlers: rpcHandlers
        )
        return session
    }

    /// A bearer credential must not travel over cleartext. `https` is
    /// always allowed; plain `http` only for loopback hosts.
    static func isSecureBaseURL(_ url: URL) -> Bool {
        if url.scheme?.lowercased() == "https" { return true }
        return isLoopbackHost(url.host)
    }

    static func isLoopbackHost(_ host: String?) -> Bool {
        guard let host else { return false }
        return localHosts.contains(host.lowercased())
    }

    private static let localHosts: Set<String> = ["localhost", "127.0.0.1", "::1"]

    /// Internal start so tests can drive a session over a fake
    /// transport while observing the same state machine the public
    /// ``start(_:config:)`` exercises.
    func _start(
        config: SessionConfig,
        micMuted: Bool = false,
        rpcHandlers: [String: ClientToolHandler] = [:]
    ) async throws {
        guard case .idle = lifecycle else {
            throw RealtimeSessionError.alreadyStarted
        }
        lifecycle = .connecting
        statesContinuation.yield(.connecting)

        var config = config
        self.hooks = config.hookEngine
        if let hooks = self.hooks, let extra = await hooks.runSessionStart() {
            if config.agentName != nil {
                Self.log.warning("a catalog agent runs its stored config verbatim — SessionStart additionalContext is not injected")
            } else {
                config.instructions = config.instructions.map { "\($0)\n\n\(extra)" } ?? extra
                Self.log.info("sessionStart hook context folded added_chars=\(extra.count, privacy: .public)")
            }
        }

        let configFrame: Data
        do {
            configFrame = try JSONEncoder().encode(config.wirePayload())
        } catch {
            let message = "session-config encode failed: \(error.localizedDescription)"
            Self.log.error("\(message, privacy: .public)")
            await _close(reason: .transportError(message: message))
            throw RealtimeSessionError.sessionStartFailed(message: message)
        }

        let callbacks = SessionTransportCallbacks(
            onFrame: { [weak self] data in await self?._receiveFrame(data) },
            onClosed: { [weak self] reason in await self?._transportClosed(reason) },
            onReconnecting: { [weak self] in await self?._transportReconnecting() },
            onReconnected: { [weak self] in await self?._transportReconnected() },
            onAgentLive: { [weak self] in await self?._agentBecameLive() }
        )

        let info: SessionStartInfo
        do {
            let sink = ClientToolJobSink(
                deliver: { [weak self] result in
                    try await self?._sendToolJobResult(result)
                },
                isOpen: { [weak self] in await self?._isSendable() ?? false }
            )
            self.clientToolJobSink = sink
            info = try await transport.connect(
                configFrame: configFrame,
                callbacks: callbacks,
                clientToolHandlers: config.clientToolHandlers()
                    .merging(config.rpcOnlyHandlers()) { _, rpcOnly in rpcOnly }
                    .merging(rpcHandlers) { _, registerOnly in registerOnly },
                backgroundClientToolHandlers: config.backgroundClientToolHandlers(),
                clientToolJobSink: sink,
                hooks: config.hookEngine,
                micMuted: micMuted
            )
        } catch let failure as SessionStartFailure {
            switch failure {
            case .rejected(let status, let code, let detail):
                Self.log.error("session start rejected status=\(status.map(String.init) ?? "nil", privacy: .public) code=\(code ?? "nil", privacy: .public) detail=\(detail, privacy: .public)")
                if status == 401, let options, case .tokenSource(let source) = options.credential {
                    // Rejected despite the refresh skew — revoked, or clocks
                    // disagree: drop the cache so the next start fetches fresh.
                    await source.invalidate()
                }
                await _close(reason: .handshakeFailed(status: status, detail: detail))
                if code == "version_mismatch" {
                    throw RealtimeSessionError.versionMismatch(detail: detail)
                }
                if status == 503 {
                    throw RealtimeSessionError.voiceDisabled
                }
                if let status {
                    throw RealtimeSessionError.handshakeFailed(
                        status: status, code: code, detail: detail
                    )
                }
                throw RealtimeSessionError.sessionStartFailed(message: detail)
            case .credential(let error):
                Self.log.error("session start credential resolution failed: \(error.localizedDescription, privacy: .public)")
                await _close(reason: .transportError(message: error.localizedDescription))
                // Un-erased on purpose: the caller branches on the mint slug
                // (``token_source_failed`` vs a server rejection), matching
                // the TypeScript and Python SDKs.
                throw error
            case .transport(let message):
                Self.log.error("session start transport failure: \(message, privacy: .public)")
                await _close(reason: .transportError(message: message))
                throw RealtimeSessionError.sessionStartFailed(message: message)
            }
        } catch {
            Self.log.error("session start failed: \(error.localizedDescription, privacy: .public)")
            await _close(reason: .transportError(message: error.localizedDescription))
            throw RealtimeSessionError.sessionStartFailed(message: error.localizedDescription)
        }

        guard case .connecting = lifecycle else {
            // A concurrent ``end()`` raced the connect; the transport
            // teardown already ran via ``_close``.
            throw RealtimeSessionError.notConnected
        }
        startResponse = info.response
        lifecycle = .connected
        statesContinuation.yield(.connected)
        // A capture only fires once the locator calls, well after this, so the
        // late bind never races. Weak because the transport retains the
        // handlers, which retain the capture slot — binding self strongly
        // would close the loop back into the session.
        for capture in config.screenLocateTools {
            capture.bindPublish { [weak self] data, topic in
                guard let self else {
                    throw ScreenToolError(
                        message: "\(ScreenLocateTool.rpcMethod): session ended before publish"
                    )
                }
                try await self.send(bytes: data, topic: topic)
            }
        }
        // The transport publishes the mic during connect, so this client is the
        // human voice: bind the agent's input.
        await _sendBindInput()
        Self.log.info("session started sessionId=\(info.sessionId, privacy: .public)")
    }

    // MARK: Sends

    /// Send a text turn to the agent. The agent replies in whatever modality
    /// the session runs in.
    public func send(text: String) async throws {
        try _assertSendable()
        try await _publish(
            CosmoRealtimeAPI.Components.Schemas.ClientText(
                content: text,
                _type: .sendText
            )
        )
    }

    /// Give the agent context without asking it anything.
    ///
    /// The note lands in the model's context for its next reply and never
    /// becomes a turn of its own: no spoken response, no assistant message,
    /// no interruption of what the agent is saying. For live application
    /// state; ``send(text:)`` is the opposite, it asks.
    public func send(context: String) async throws {
        try _assertSendable()
        try await _publish(
            CosmoRealtimeAPI.Components.Schemas.ClientContext(
                content: context,
                _type: .sendContext
            )
        )
    }

    /// Mute or unmute the microphone. Sends the wire ``mute`` frame
    /// (so the agent can update VAD state) and toggles local capture.
    /// Throws if the capture toggle fails — notably a denied-permission
    /// first publish when unmuting a session that joined muted.
    public func setMuted(_ muted: Bool) async throws {
        try _assertSendable()
        try await _publish(
            CosmoRealtimeAPI.Components.Schemas.ClientMute(muted: muted, _type: .mute)
        )
        try await transport.setMicrophoneEnabled(!muted)
        lastSetMuted = muted
    }

    /// Keep-alive; the server replies with ``Event/pong``.
    public func ping() async throws {
        try _assertSendable()
        try await _publish(
            CosmoRealtimeAPI.Components.Schemas.ClientPing(_type: .ping)
        )
    }

    /// Send a single image frame to the agent, downscaled to `maxLongEdge`.
    ///
    /// Preferred over the base64 overload: bounding happens here, before the
    /// pixels are ever encoded or base64-inflated, so an oversized capture
    /// costs nothing to discard. See ``ImageDownscale`` for why the default
    /// ceiling is 1280 and when to raise it.
    public func send(
        image: CGImage,
        maxLongEdge: Int = ImageDownscale.recommendedMaxLongEdge,
        quality: Double = ImageDownscale.recommendedQuality,
        streamId: String = "video.input.default"
    ) async throws {
        try _assertSendable()
        let encoded = try ImageDownscale.encodeJPEG(
            image: image,
            maxLongEdge: maxLongEdge,
            quality: quality
        )
        // Publish directly rather than routing through the base64 overload:
        // this frame is already bounded to the caller's `maxLongEdge`, and
        // that path would re-clamp it to the default and undo a deliberately
        // raised ceiling.
        try await _publishImage(
            base64: encoded.base64,
            mimeType: encoded.mimeType,
            streamId: streamId
        )
    }

    /// Send a single image frame to the agent as base64 JSON.
    ///
    /// ``data`` is the base64-encoded image bytes (not raw bytes). Use this
    /// for one-shot captures (a photo, a screenshot, a sampled frame) where
    /// publishing a continuous video track would be overkill. Oversized
    /// frames are split into ``envelope-chunk`` packets transparently by
    /// ``_publish(_:)``; the server reassembles before dispatch.
    ///
    /// A payload past ``imageBase64InspectThreshold`` is decoded, and re-encoded
    /// at ``ImageDownscale/recommendedMaxLongEdge`` if its long edge exceeds it.
    /// This is a guard against egregiously oversized frames, not a categorical
    /// resolution bound: an over-resolution frame that compresses below the
    /// threshold is forwarded unchanged, because reading its dimensions would
    /// mean decoding every frame every caller sends. For a guaranteed bound
    /// (and no lossy re-encode), use
    /// ``send(image:maxLongEdge:quality:streamId:)``.
    public func send(
        image data: String,
        mimeType: String = "image/jpeg",
        streamId: String = "video.input.default"
    ) async throws {
        try _assertSendable()
        var payload = data
        var payloadMimeType = mimeType
        if data.count > Self.imageBase64InspectThreshold {
            var reencode: ReencodeNote?
            payload = try Self._bounded(
                base64: data,
                originalLength: data.count,
                mimeType: &payloadMimeType,
                reencode: &reencode
            )
            if let note = reencode, !didWarnImageReencode {
                didWarnImageReencode = true
                Self.log.warning(
                    "send(image:) re-encoded an oversized frame base64_len=\(note.from, privacy: .public)->\(note.to, privacy: .public) dims=\(note.width, privacy: .public)x\(note.height, privacy: .public) — encode at \(ImageDownscale.recommendedMaxLongEdge, privacy: .public)px to avoid this round trip (logged once per session)"
                )
            }
        }
        try await _publishImage(
            base64: payload,
            mimeType: payloadMimeType,
            streamId: streamId
        )
    }

    private func _publishImage(
        base64: String,
        mimeType: String,
        streamId: String
    ) async throws {
        try await _publish(
            CosmoRealtimeAPI.Components.Schemas.ClientImage(
                data: base64,
                mimeType: mimeType,
                streamId: streamId,
                _type: .sendImage
            )
        )
    }

    /// Downscale an oversized base64 frame, or fail with the measured size and
    /// the recommended dimension. Only reached for payloads already past
    /// ``imageBase64InspectThreshold``.
    static func _bounded(
        base64: String,
        originalLength: Int,
        mimeType: inout String,
        reencode: inout ReencodeNote?
    ) throws -> String {
        // Downscaling is attempted before the hard limit is enforced: a
        // full-resolution capture well past the limit usually lands far under
        // it once bounded, and rejecting it first would refuse a frame we can
        // trivially make sendable.
        let downscaled: ImageDownscale.Encoded?
        do {
            downscaled = try ImageDownscale.downscaleBase64(base64)
        } catch let error as ImageDownscale.Error {
            guard originalLength > maxImageBase64Length else {
                // Sendable size, just not downscalable (an unrecognized
                // encoding). The server bound still applies; send as given.
                log.warning(
                    "send(image:) could not downscale frame base64_len=\(originalLength, privacy: .public): \(error.description, privacy: .public)"
                )
                return base64
            }
            log.error(
                "send(image:) rejected oversized frame base64_len=\(originalLength, privacy: .public) limit=\(maxImageBase64Length, privacy: .public): \(error.description, privacy: .public)"
            )
            throw Self._tooLarge(originalLength)
        }

        guard let encoded = downscaled else {
            // Within the pixel ceiling but over the byte threshold — a
            // low-compression or lossless encode. Re-encoding buys nothing.
            guard originalLength > maxImageBase64Length else { return base64 }
            log.error(
                "send(image:) rejected frame within the pixel bound but over the byte limit base64_len=\(originalLength, privacy: .public)"
            )
            throw Self._tooLarge(originalLength)
        }

        guard encoded.base64.count <= maxImageBase64Length else {
            log.error(
                "send(image:) frame still over the byte limit after downscaling base64_len=\(encoded.base64.count, privacy: .public)"
            )
            throw Self._tooLarge(encoded.base64.count)
        }

        mimeType = encoded.mimeType
        reencode = ReencodeNote(
            from: originalLength,
            to: encoded.base64.count,
            width: encoded.width,
            height: encoded.height
        )
        return encoded.base64
    }

    /// One re-encode, for the caller to log. A caller that streams stills is
    /// re-encoding every frame, so this is reported once per session rather
    /// than once per frame.
    struct ReencodeNote {
        let from: Int
        let to: Int
        let width: Int
        let height: Int
    }

    private static func _tooLarge(_ length: Int) -> ImageDownscale.Error {
        .payloadTooLarge(
            base64Length: length,
            limit: maxImageBase64Length,
            recommendedLongEdge: ImageDownscale.recommendedMaxLongEdge
        )
    }

    /// Stream raw bytes to the agent on a named ``topic``, out of band from
    /// the JSON control channel. For large binary client-tool payloads — a
    /// grounding screenshot plus its accessibility dump, say — that would be
    /// wasteful to base64 onto the control channel. Delivered only to the
    /// agent participant. Internal: the screen tools' capture publish is the
    /// consumer, matching the Python/TypeScript SDKs, which keep byte-stream
    /// sending inside their tool plumbing.
    func send(bytes data: Data, topic: String) async throws {
        try _assertSendable()
        try await transport.sendBytes(data, topic: topic)
    }

    /// Signal manual-VAD end-of-turn: the user's "I'm done speaking" hint
    /// for turn-taking modes where silence detection is off. Unlike
    /// ``setMuted(_:)`` this has no microphone-capture side effect.
    public func sendActivityEnd() async throws {
        try _assertSendable()
        try await _publish(
            CosmoRealtimeAPI.Components.Schemas.ClientActivityEnd(_type: .activityEnd)
        )
    }

    /// Suspend until the agent participant has published a track, or the
    /// session ends first. Returns immediately if it already has.
    ///
    /// This is liveness, not readiness: it proves an agent is on the other
    /// end, and carries no session metadata. Keep awaiting
    /// ``Event/ready(_:)`` on ``events`` for the session id, rejected tools,
    /// and the effective duration cap.
    public func waitUntilAgentLive() async {
        if didSignalAgentLive { return }
        if case .closed = lifecycle { return }
        await withCheckedContinuation { continuation in
            agentLiveWaiters.append(continuation)
        }
    }

    /// Suspend until the session has ended, for any reason — ``end()``, a
    /// server-side stop, or a transport drop. Returns immediately if it
    /// already has. Any number of tasks may wait.
    ///
    /// This is the supported way to hold a process open for the length of a
    /// call. It does not consume ``events``, so a separate task can drain the
    /// stream while the main path awaits this.
    public func waitUntilEnded() async {
        if case .closed = lifecycle { return }
        await withCheckedContinuation { continuation in
            endWaiters.append(continuation)
        }
    }

    /// Gracefully end the session: best-effort wire ``end`` frame, then
    /// terminal teardown with ``EndReason/clientEnded``. Idempotent.
    /// Teardown is immediate — events still in flight are dropped, so
    /// consume the turn's final transcript event before ending if you
    /// need it.
    public func end() async {
        let canSend: Bool
        switch lifecycle {
        case .connected, .reconnecting: canSend = true
        default: canSend = false
        }
        if canSend {
            do {
                try await _publish(
                    CosmoRealtimeAPI.Components.Schemas.ClientEnd(_type: .end)
                )
            } catch {
                // Best-effort: the transport may already be gone. Record it
                // and tear down regardless.
                Self.log.warning(
                    "end frame publish failed; closing anyway: \(error.localizedDescription, privacy: .public)"
                )
            }
        }
        await _close(reason: .clientEnded)
    }

    /// Abrupt local teardown without the wire ``end`` frame. The stream
    /// finishes with reason ``client_closed``. Idempotent.
    public func close() async {
        await _close(reason: .clientClosed)
    }

    // Internal (not private) so the sibling send extensions in this module
    // reuse the one send path.
    func _assertSendable() throws {
        switch lifecycle {
        case .connected, .reconnecting:
            break
        default:
            throw RealtimeSessionError.notConnected
        }
    }

    /// Whether an outbound cosmo message can be sent right now — the sink checks
    /// this before publishing a terminal ``tool_job_result``.
    func _isSendable() -> Bool {
        switch lifecycle {
        case .connected, .reconnecting: return true
        default: return false
        }
    }

    func _publish<Frame: Encodable>(_ frame: Frame) async throws {
        let data = try JSONEncoder().encode(frame)
        let outbound = buildOutboundPackets(data)
        guard !outbound.packets.isEmpty else {
            throw RealtimeSessionError.invalidPayload(
                "refusing to nest envelope-chunk inside another envelope"
            )
        }
        for packet in outbound.packets {
            try await transport.send(frame: packet)
        }
    }

    // MARK: Inbound

    func _receiveFrame(_ data: Data) async {
        if case .closed = lifecycle { return }
        switch Self.classifyFrame(data) {
        case .envelopeChunk(let envelopeId, let seq, let total, let chunkData):
            let result = await reassembler.consume(
                envelopeId: envelopeId,
                seq: seq,
                total: total,
                data: chunkData
            )
            switch result {
            case .pending:
                break
            case .complete(let assembled):
                await _receiveFrame(assembled)
            case .invalid(let reason):
                // Tolerant posture: a broken envelope can't be trusted
                // but must not kill the session — surface it on the
                // forward-compatibility variant and keep going.
                Self.log.warning("envelope invalid: \(reason, privacy: .public); surfacing as unknown event")
                eventsContinuation.yield(.unknown(rawType: "server-envelope-chunk", payload: data))
            }
        case .serverSessionEnded(let reason):
            serverEndReason = reason
            _armServerEndGrace()
        case .event(let event):
            eventsContinuation.yield(event)
        }
    }

    private func _transportReconnecting() {
        guard case .connected = lifecycle else { return }
        lifecycle = .reconnecting
        statesContinuation.yield(.reconnecting)
    }

    private func _transportReconnected() {
        guard case .reconnecting = lifecycle else { return }
        lifecycle = .connected
        statesContinuation.yield(.reconnected)
        // The one-shot bind doesn't survive a transport drop; this surface is
        // always the voice (it publishes the mic during connect), so re-assert
        // the input binding on the recovered connection.
        Task { [weak self] in await self?._sendBindInput() }
        // The server-side mic gate is session-server state that may reset with
        // the transport; re-assert the last state this client set. Best-effort.
        if let muted = lastSetMuted {
            Task { [weak self] in await self?._resendMute(muted) }
        }
    }

    private func _resendMute(_ muted: Bool) async {
        do {
            try await _publish(
                CosmoRealtimeAPI.Components.Schemas.ClientMute(muted: muted, _type: .mute)
            )
        } catch {
            Self.log.warning("mute re-assert after reconnect failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Tell the server this client is the human voice — bind the agent's input
    /// to us. Best-effort: a transient data-channel hiccup must not fail an
    /// otherwise-live session.
    private func _sendBindInput() async {
        do {
            try await _publish(
                CosmoRealtimeAPI.Components.Schemas.ClientBindInput(_type: .bindInput)
            )
        } catch {
            Self.log.warning(
                "bind-input publish failed: \(error.localizedDescription, privacy: .public)"
            )
        }
    }

    // MARK: Teardown

    /// Unsolicited transport teardown: a latched server ``session-ended``
    /// reason wins over the transport's own classification of the same
    /// close. Client-initiated paths call ``_close`` directly and ignore
    /// the latch.
    private func _transportClosed(_ reason: EndReason) async {
        await _close(reason: serverEndReason.map { .serverEnded(reason: $0) } ?? reason)
    }

    /// ``session-ended`` is normally followed by the transport closing; if
    /// that close never arrives, finish after a grace so iteration doesn't
    /// hang forever.
    private func _armServerEndGrace() {
        guard serverEndGraceTask == nil else { return }
        let grace = serverEndGraceNanos
        serverEndGraceTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: grace)
            await self?._serverEndGraceFired()
        }
    }

    private func _serverEndGraceFired() async {
        serverEndGraceTask = nil
        if case .closed = lifecycle { return }
        guard let reason = serverEndReason else { return }
        Self.log.warning("session-ended without a transport close — forcing teardown")
        await _close(reason: .serverEnded(reason: reason))
    }

    /// Single terminal teardown path. Idempotent; synthesizes the
    /// terminal ``Event/sessionEnded(_:)`` sentinel as the final event of
    /// a session that reached the live stream, finishes both streams, and
    /// closes the transport.
    private func _close(reason: EndReason) async {
        if case .closed = lifecycle { return }
        serverEndGraceTask?.cancel()
        serverEndGraceTask = nil
        let wasLive: Bool
        switch lifecycle {
        case .connected, .reconnecting: wasLive = true
        default: wasLive = false
        }
        lifecycle = .closed
        // Cancel any in-flight background client-tool jobs; their results have
        // nowhere to land once the session is torn down.
        await clientToolJobSink?.close()
        clientToolJobSink = nil
        Self.log.info("session closed reason=\(String(describing: reason), privacy: .public)")
        if let hooks {
            let (hookReason, detail) = reason.sessionEndReason
            await hooks.runSessionEnd(
                SessionEndContext(reason: hookReason, detail: detail, sessionId: self.sessionId)
            )
        }
        // The transport close is the terminal signal (the server's
        // best-effort ``session-ended`` frame only latches a reason). A
        // session that reached the live stream ends with a locally
        // synthesized terminal sentinel as its final event; start-time
        // failures (never live) just finish. Mirrors the reference SDK.
        if wasLive {
            eventsContinuation.yield(.sessionEnded(SessionEnded(reason: reason.endedReason)))
        }
        statesContinuation.yield(.disconnected(reason: reason))
        statesContinuation.finish()
        eventsContinuation.finish()
        agentLiveContinuation.finish()
        await transport.close()
        if let onClose {
            self.onClose = nil
            await onClose()
        }
        // Last: a waiter that wakes up sees a fully torn-down session. The
        // agent-live waiters are released too — the agent never showed, and
        // leaving them parked would hang the caller past the session.
        let live = agentLiveWaiters
        agentLiveWaiters = []
        for waiter in live { waiter.resume() }
        let waiters = endWaiters
        endWaiters = []
        for waiter in waiters { waiter.resume() }
    }
}

extension RealtimeSession.Options {
    /// The middleware stack every generated-client construction shares: bearer
    /// auth, and the room ref when a prepared room was taken.
    func _apiMiddlewares(
        prepared: PreparedRoom?
    ) -> [any ClientMiddleware] {
        var middlewares: [any ClientMiddleware] = [
            BearerAuthMiddleware(credential: credential)
        ]
        if let prepared {
            middlewares.append(PreparedRoomHeaderMiddleware(
                roomName: prepared.roomName, roomGrant: prepared.roomGrant
            ))
        }
        return middlewares
    }
}

extension RealtimeSession.EndReason {
    /// Informational reason string carried on the synthesized
    /// ``RealtimeSession/Event/sessionEnded(_:)`` sentinel.
    var endedReason: String? {
        switch self {
        case .clientEnded: return "client_ended"
        case .clientClosed: return "client_closed"
        case .serverEnded(let reason): return reason
        case .handshakeFailed(_, let detail): return detail
        case .transportError(let message): return message
        }
    }

    /// Typed ``(reason, detail)`` pair for the ``SessionEndContext``.
    var sessionEndReason: (reason: DisconnectReason, detail: String?) {
        switch self {
        case .clientEnded: return (.clientEnded, nil)
        case .clientClosed: return (.clientClosed, nil)
        case .handshakeFailed(_, let detail): return (.handshakeFailed, detail)
        case .serverEnded(let reason): return (.serverEnded, reason)
        case .transportError(let message): return (.transportError, message)
        }
    }
}

// MARK: - Errors

public enum RealtimeSessionError: Error, LocalizedError, Equatable {
    /// The server refused the session start because this SDK speaks an
    /// incompatible protocol version. Upgrade the SDK.
    case versionMismatch(detail: String)
    /// The backend returned HTTP 503: realtime voice is temporarily
    /// unavailable (provider/LiveKit not configured, or an infra 503).
    /// Branch on this to show a "voice unavailable" state rather than a
    /// generic failure.
    case voiceDisabled
    /// The server refused the session start with an HTTP rejection that
    /// wasn't a more specific case (auth failure, bad request, …);
    /// ``status`` is the HTTP status, ``code`` the machine-readable rejection
    /// slug for typed rejections (e.g. ``invalid_tool_config`` /
    /// ``name_conflict`` — branch on it instead of matching the human
    /// message), and ``detail`` the server detail when available.
    case handshakeFailed(status: Int, code: String?, detail: String?)
    /// The session start failed (server rejection or transport
    /// failure); ``message`` carries the server detail when available.
    case sessionStartFailed(message: String)
    /// ``RealtimeSession`` is single-attempt; construct a new session
    /// instead of starting one twice.
    case alreadyStarted
    /// A send was attempted outside an active session.
    case notConnected
    /// The transport failed while starting the session (thrown from
    /// ``RealtimeSession/start(_:config:)``). A mid-session transport drop
    /// does not throw here — it ends the ``RealtimeSession/events`` stream
    /// with a terminal ``RealtimeSession/Event/sessionEnded(_:)`` instead.
    case transportError(message: String)
    /// A caller-supplied payload would violate a wire-protocol
    /// invariant.
    case invalidPayload(String)
    /// Screen share could not be started because the LiveKit
    /// ``BufferCapturer`` could not be created.
    case screenShareUnavailable
    /// A video publish (stream or screen share) is already active on
    /// this session; remove or stop it before starting another.
    case videoPublishAlreadyActive
    /// A caller-owned audio stream is already active on this session;
    /// remove it before starting another.
    case audioPublishAlreadyActive
    /// The base URL is plain `http` to a non-loopback host; a bearer
    /// credential must not travel over cleartext.
    case insecureBaseURL(String)

    public var errorDescription: String? {
        switch self {
        case .versionMismatch(let detail):
            return "Realtime protocol version mismatch: \(detail)"
        case .voiceDisabled:
            return "Realtime voice is temporarily unavailable."
        case .handshakeFailed(let status, let code, let detail):
            let slug = code.map { ", \($0)" } ?? ""
            if let detail {
                return "Session start rejected (HTTP \(status)\(slug)): \(detail)"
            }
            return "Session start rejected (HTTP \(status)\(slug))."
        case .sessionStartFailed(let message):
            return "Session start failed: \(message)"
        case .alreadyStarted:
            return "RealtimeSession.start already ran for this session; start a new session instead."
        case .notConnected:
            return "RealtimeSession is not connected."
        case .transportError(let message):
            return "Realtime transport failed: \(message)"
        case .invalidPayload(let detail):
            return "Invalid wire payload: \(detail)"
        case .screenShareUnavailable:
            return "Screen share is unavailable: LiveKit BufferCapturer could not be created."
        case .videoPublishAlreadyActive:
            return "A video publish is already active on this session; remove or stop it before starting another."
        case .audioPublishAlreadyActive:
            return "An audio stream is already active on this session; remove it before starting another."
        case .insecureBaseURL(let url):
            return "Realtime base URL must use https (http allowed only for localhost): \(url)"
        }
    }
}
