import CoreMedia
import CosmoRealtimeAPI
import Foundation
import LiveKit
import OpenAPIRuntime
import OpenAPIURLSession
import os
import os.lock

/// Production ``SessionTransport``: REST session-start against the
/// published API + a LiveKit room for audio and the data channel.
/// Connect shape: publish-during-join, bounded room-connect timeout,
/// transient data-channel retry.
actor LiveKitSessionTransport: SessionTransport {

    fileprivate static let log = Logger(subsystem: CosmoRealtimeLog.subsystem, category: "session-transport")

    private let options: RealtimeSession.Options
    // Accessed by the screen-share extension (deferred publish reads it)
    // and the DEBUG test hooks; the rest of the transport is the only
    // writer outside those.
    var room: Room?
    // Retained here because LiveKit stores delegates weakly. Not `private`
    // so the DEBUG-only test hook that wires a room for E2E can retain it too.
    var roomDelegate: SessionRoomDelegate?
    private var framePump: Task<Void, Never>?

    /// Await the frame pump finishing its buffered frames. The disconnect
    /// delegate arms call this after ``frames.finish()`` so a buffered
    /// ``session-ended`` frame latches before the close reaches the session.
    func awaitFramePumpDrained() async {
        await framePump?.value
    }

    // Latest-value RMS streams: a slow waveform consumer must drop
    // intermediate samples, not accumulate them. The taps are
    // ``AudioRenderer``s LiveKit drives off the render callback — no
    // timer of our own.
    nonisolated let inputLevels: AsyncStream<Float>
    nonisolated let outputLevels: AsyncStream<Float>
    // Internal (not private) so the DEBUG test hooks can feed synthetic
    // RMS without a real audio track; the screen-share lock follows the
    // same convention.
    nonisolated let inputLevelContinuation: AsyncStream<Float>.Continuation
    nonisolated let outputLevelContinuation: AsyncStream<Float>.Continuation
    private nonisolated let inputLevelTap: AudioLevelTap
    private nonisolated let outputLevelTap: AudioLevelTap
    private nonisolated let attachedLocalTrack = OSAllocatedUnfairLock<LocalAudioTrack?>(initialState: nil)
    // The single agent-audio track currently feeding the output level tap,
    // plus its publication SID. Only one agent voice drives the waveform at a
    // time, so this is a single slot: a new subscription replaces it.
    nonisolated let attachedRemoteTrack = OSAllocatedUnfairLock<(sid: Track.Sid, track: RemoteAudioTrack)?>(initialState: nil)
    // Software playback gain (0…1) for the agent's audio. Stored so a track
    // attaching later (agent republish, reconnect) inherits it; applied to the
    // currently-subscribed track by ``setAgentPlaybackVolume``. Internal (not
    // private), like the level continuations above, so a `@testable` unit test
    // can assert the clamp without a real LiveKit track.
    nonisolated let desiredAgentVolume = OSAllocatedUnfairLock<Double>(initialState: 1.0)

    // Connect-phase timings. Lock-guarded and ``Sendable`` so the write
    // during connect and the read at ``close()`` share it without hopping
    // the actor. Read via ``connectTimings``.
    nonisolated let timings = SessionConnectTimingsRecorder()

    // Screen-share state lives lock-backed and nonisolated so
    // ``pushScreenShareFrame`` can feed frames from a 60fps capture
    // thread without hopping the actor. The actor-isolated methods
    // touch the same locks.
    nonisolated let screenShareLock = OSAllocatedUnfairLock<ScreenShareState?>(initialState: nil)
    nonisolated let screenShareFrameProcessorLock = OSAllocatedUnfairLock<ScreenShareFrameProcessor?>(initialState: nil)
    nonisolated let screenShareFailedListeners = OSAllocatedUnfairLock<[UUID: @Sendable (Error) -> Void]>(initialState: [:])
    // Same treatment for the caller-owned audio publish: pushes arrive on an
    // audio-render thread and must not hop the actor.
    nonisolated let audioStreamLock = OSAllocatedUnfairLock<AudioStreamState?>(initialState: nil)
    // Set in ``close()`` and checked in the deferred publish so a torn-
    // down room never gets a late publish.
    nonisolated let isClosed = OSAllocatedUnfairLock<Bool>(initialState: false)

    init(options: RealtimeSession.Options) {
        self.options = options
        let inStream = AsyncStream<Float>.makeStream(bufferingPolicy: .bufferingNewest(1))
        self.inputLevels = inStream.stream
        self.inputLevelContinuation = inStream.continuation
        self.inputLevelTap = AudioLevelTap(continuation: inStream.continuation)
        let outStream = AsyncStream<Float>.makeStream(bufferingPolicy: .bufferingNewest(1))
        self.outputLevels = outStream.stream
        self.outputLevelContinuation = outStream.continuation
        self.outputLevelTap = AudioLevelTap(continuation: outStream.continuation)
    }

    nonisolated var connectTimings: SessionConnectTimings { timings.snapshot() }

    func connect(
        configFrame: Data,
        callbacks: SessionTransportCallbacks,
        clientToolHandlers: [String: ClientToolHandler],
        backgroundClientToolHandlers: [String: BackgroundClientToolHandler],
        clientToolJobSink: ClientToolJobSink?,
        hooks: HookEngine?,
        micMuted: Bool
    ) async throws -> SessionStartInfo {
        let handshakeStart = Date()
        let config: CosmoRealtimeAPI.Components.Schemas.SessionConfig
        do {
            config = try JSONDecoder().decode(
                CosmoRealtimeAPI.Components.Schemas.SessionConfig.self,
                from: configFrame
            )
        } catch {
            throw SessionStartFailure.transport(
                message: "session-config round-trip failed: \(error.localizedDescription)"
            )
        }

        // Fast path: a room supplied by an installed ``PreparedRoomProviding``
        // — already created and edge-resolved. Join immediately on its held
        // token while ``/session/start`` runs in a parallel task, so the start
        // RTT leaves the join's critical path. The start carries the room ref
        // (header middleware) so the backend dispatches the agent onto that
        // room. With no provider installed there is nothing to take and the
        // connect is serialized.
        let prepared = RealtimeSession._takePreparedRoom(for: options)
        let restClient = CosmoRealtimeAPI.Client(
            serverURL: options.baseURL,
            transport: makeRESTTransport(options: options),
            middlewares: options._apiMiddlewares(prepared: prepared)
        )

        let newRoom: Room
        let joinURL: String
        let joinToken: String
        // The resolved REST start plus its completion instant. On the fast
        // path it settles concurrently with the join; on the serialized path
        // it has already resolved when awaited below.
        let startTask: Task<(CosmoRealtimeAPI.Components.Schemas.SessionResponse, Date), Error>
        if let prepared {
            let ageMs = Int(Date().timeIntervalSince(prepared.preparedAt) * 1000)
            Self.log.notice(
                "connect path=prepared room=\(prepared.roomName, privacy: .public) prepared_age_ms=\(ageMs, privacy: .public)"
            )
            newRoom = prepared.room
            joinURL = prepared.livekitURL
            joinToken = prepared.token
            startTask = Task {
                let session = try await Self._callStart(client: restClient, config: config)
                return (session, Date())
            }
        } else {
            Self.log.notice("connect path=serialized (no prepared room)")
            let session = try await Self._callStart(client: restClient, config: config)
            newRoom = makeSessionRoom()
            joinURL = session.livekitUrl
            joinToken = session.token
            let restDoneAt = Date()
            startTask = Task { (session, restDoneAt) }
        }

        let joinStartedAt = Date()
        let frameStream = AsyncStream<Data>.makeStream(bufferingPolicy: .unbounded)
        let delegate = SessionRoomDelegate(
            frames: frameStream.continuation,
            callbacks: callbacks,
            transport: self
        )
        newRoom.delegates.add(delegate: delegate)

        // Bind client-tool RPC methods BEFORE the join: LiveKit's method
        // registry is room-local state independent of the connection, so an
        // agent invocation landing in the join window (first-turn tool call,
        // prepared fast path) finds its handler instead of "method not
        // found". The session id resolves per invocation off the start
        // response — an invocation can only originate from the agent the
        // start dispatched, so it settles first in practice.
        let startSessionId: @Sendable () async -> String? = {
            (try? await startTask.value)?.0.sessionId
        }
        do {
            try await Self.bindClientTools(
                on: newRoom,
                clientToolHandlers: clientToolHandlers,
                backgroundClientToolHandlers: backgroundClientToolHandlers,
                clientToolJobSink: clientToolJobSink,
                hooks: hooks,
                sessionId: startSessionId
            )
        } catch {
            newRoom.delegates.remove(delegate: delegate)
            frameStream.continuation.finish()
            startTask.cancel()
            Task { [newRoom] in await newRoom.disconnect() }
            throw SessionStartFailure.transport(message: error.localizedDescription)
        }

        // Run the join as a task so the start response can be awaited FIRST:
        // it is typically the faster leg, and it alone can reveal a
        // prepared-room mismatch. Waiting for the join before checking would
        // make a mismatched (version-skew) connect pay the full prepared join
        // AND the rejoin back to back — measured ~2s of avoidable latency.
        // On the serialized path ``startTask`` is already resolved, so this
        // ordering degenerates to the same sequence as before.
        let joinTask = Task {
            try await self._joinRoom(newRoom, url: joinURL, token: joinToken, micMuted: micMuted)
        }

        let session: CosmoRealtimeAPI.Components.Schemas.SessionResponse
        let restDoneAt: Date
        // Set once the prepared join has been given up on, so the dispatched
        // room is joined instead.
        var preparedJoinAbandoned = false
        do {
            (session, restDoneAt) = try await startTask.value
        } catch {
            _abandonJoin(
                room: newRoom, delegate: delegate,
                continuation: frameStream.continuation, joinTask: joinTask
            )
            guard prepared != nil, Self._isPreparedRoomRefusal(error) else {
                Self.log.error(
                    "session start failed: \(error.localizedDescription, privacy: .public)"
                )
                throw error
            }
            // The backend refused the room ref — its grant is bound to the
            // user and workspace that prepared it, so a credential change the
            // provider didn't catch, or a server-side key rotation, lands
            // here. Retry the start without the ref rather than failing a
            // connect the serialized path would have completed.
            Self.log.warning("prepared room refused at session start — retrying without it")
            session = try await Self._callStart(
                client: CosmoRealtimeAPI.Client(
                    serverURL: options.baseURL,
                    transport: makeRESTTransport(options: options),
                    middlewares: options._apiMiddlewares(prepared: nil)
                ),
                config: config
            )
            restDoneAt = Date()
            preparedJoinAbandoned = true
        }
        if let t = session.timings {
            timings.setServerTimings(t)
        }

        // Version-skew fallback: a backend that doesn't read the room-ref
        // headers dispatched the agent onto a fresh room. The response's
        // ``roomName`` is authoritative — give up on the still-in-flight
        // prepared join and take the dispatched room instead. The skew connect
        // then costs REST + one join, same as the serialized path.
        if let prepared, !preparedJoinAbandoned, session.roomName != prepared.roomName {
            Self.log.warning(
                "prepared room not honored by backend (prepared=\(prepared.roomName, privacy: .public) dispatched=\(session.roomName, privacy: .public)) — abandoning the prepared join, joining the dispatched room"
            )
            _abandonJoin(
                room: newRoom, delegate: delegate,
                continuation: frameStream.continuation, joinTask: joinTask
            )
            preparedJoinAbandoned = true
        }

        let activeRoom: Room
        let activeDelegate: SessionRoomDelegate
        let activeStream: (stream: AsyncStream<Data>, continuation: AsyncStream<Data>.Continuation)
        let roomConnectedAt: Date
        if preparedJoinAbandoned {
            let joined = try await _joinDispatchedRoom(
                session: session,
                callbacks: callbacks,
                clientToolHandlers: clientToolHandlers,
                backgroundClientToolHandlers: backgroundClientToolHandlers,
                clientToolJobSink: clientToolJobSink,
                hooks: hooks,
                micMuted: micMuted
            )
            activeRoom = joined.room
            activeDelegate = joined.delegate
            activeStream = joined.stream
            roomConnectedAt = Date()
        } else {
            do {
                try await joinTask.value
            } catch {
                // The dispatch already went out with the start; the agent's
                // empty room is reaped by the server-side no-show watchdog.
                frameStream.continuation.finish()
                throw error
            }
            activeRoom = newRoom
            activeDelegate = delegate
            activeStream = frameStream
            roomConnectedAt = Date()
            if prepared != nil {
                let startLeadMs = Int(roomConnectedAt.timeIntervalSince(restDoneAt) * 1000)
                Self.log.info("prepared join completed start_lead_ms=\(startLeadMs, privacy: .public)")
            }
        }

        let micMs: Double
        if micMuted {
            // Privacy: no mic track is published during the connect window.
            // It first publishes on ``setMicrophoneEnabled(true)``, which
            // attaches the input tap then — so there is no publish phase
            // here.
            micMs = 0
        } else {
            let micPublishStart = Date()
            let micPublication: LocalTrackPublication?
            do {
                micPublication = try await activeRoom.localParticipant.setMicrophone(enabled: true)
            } catch {
                activeStream.continuation.finish()
                await activeRoom.disconnect()
                throw SessionStartFailure.transport(
                    message: "mic publish failed: \(error.localizedDescription)"
                )
            }
            micMs = Date().timeIntervalSince(micPublishStart) * 1000
            if let micTrack = micPublication?.track as? LocalAudioTrack {
                await attachMicInstrumentation(to: micTrack)
            }
        }
        // Connect-ready: after the mic publish, so ``total`` spans the whole
        // connect. A muted join (which skips the publish) is therefore not
        // undercounted by pinning total to the room-connect instant.
        let connectReadyAt = Date()

        let phases = Self.connectPhases(
            handshakeStart: handshakeStart,
            restDoneAt: restDoneAt,
            joinStartedAt: joinStartedAt,
            roomConnectedAt: roomConnectedAt,
            connectReadyAt: connectReadyAt,
            micMs: micMs
        )
        timings.setConnectPhases(
            wsMs: phases.wsMs, roomMs: phases.roomMs,
            micMs: phases.micMs, totalMs: phases.totalMs
        )

        self.room = activeRoom
        self.roomDelegate = activeDelegate
        // FIFO frame pump: the delegate yields packets synchronously in
        // arrival order; this single consumer awaits the session per
        // frame so inbound order is preserved end to end. Ends when the
        // delegate finishes the stream at room teardown — no timers, no
        // polling.
        self.framePump = Task { [stream = activeStream.stream] in
            for await data in stream {
                await callbacks.onFrame(data)
            }
        }
        Self.log.info("transport connected sessionId=\(session.sessionId, privacy: .public)")
        return SessionStartInfo(response: session)
    }

    /// Give up on an in-flight join without waiting for it: detach the
    /// delegate first so its teardown can't fire ``onClosed`` for a room this
    /// session never used, then let the join settle off the caller's path
    /// (cancel is cooperative; LiveKit may run to its own timeout) and
    /// disconnect whatever it established.
    private func _abandonJoin(
        room: Room,
        delegate: SessionRoomDelegate,
        continuation: AsyncStream<Data>.Continuation,
        joinTask: Task<Void, Error>
    ) {
        room.delegates.remove(delegate: delegate)
        continuation.finish()
        joinTask.cancel()
        Task { [room] in
            if case .failure(let joinError) = await joinTask.result {
                Self.log.info(
                    "abandoned join settled with error: \(joinError.localizedDescription, privacy: .public)"
                )
            }
            await room.disconnect()
        }
    }

    /// Join the room the backend actually dispatched, on the response's own
    /// token. The path taken whenever a prepared room could not be used —
    /// refused at start, or not honored.
    private func _joinDispatchedRoom(
        session: CosmoRealtimeAPI.Components.Schemas.SessionResponse,
        callbacks: SessionTransportCallbacks,
        clientToolHandlers: [String: ClientToolHandler],
        backgroundClientToolHandlers: [String: BackgroundClientToolHandler],
        clientToolJobSink: ClientToolJobSink?,
        hooks: HookEngine?,
        micMuted: Bool
    ) async throws -> (
        room: Room,
        delegate: SessionRoomDelegate,
        stream: (stream: AsyncStream<Data>, continuation: AsyncStream<Data>.Continuation)
    ) {
        let room = makeSessionRoom()
        let stream = AsyncStream<Data>.makeStream(bufferingPolicy: .unbounded)
        let delegate = SessionRoomDelegate(
            frames: stream.continuation, callbacks: callbacks, transport: self
        )
        room.delegates.add(delegate: delegate)
        do {
            // Same pre-join binding as the primary room — the dispatched
            // room's agent is already live, so the join window is real.
            try await Self.bindClientTools(
                on: room,
                clientToolHandlers: clientToolHandlers,
                backgroundClientToolHandlers: backgroundClientToolHandlers,
                clientToolJobSink: clientToolJobSink,
                hooks: hooks,
                sessionId: { session.sessionId }
            )
        } catch {
            stream.continuation.finish()
            throw SessionStartFailure.transport(message: error.localizedDescription)
        }
        do {
            try await _joinRoom(
                room, url: session.livekitUrl, token: session.token, micMuted: micMuted
            )
        } catch {
            stream.continuation.finish()
            throw error
        }
        return (room, delegate, stream)
    }

    /// A start refused because of the room ref it carried. The backend answers
    /// a grant it won't honor with a plain `{"detail": …}` 403, which the
    /// generated client surfaces as an undocumented status rather than the
    /// error envelope. Only consulted when a room ref was actually sent, so a
    /// 403 from anywhere else in the auth stack still surfaces to the caller —
    /// via the retry, which reproduces it without the ref.
    private static func _isPreparedRoomRefusal(_ error: any Error) -> Bool {
        guard
            let failure = error as? SessionStartFailure,
            case .rejected(let status, _, _) = failure
        else { return false }
        return status == 403
    }

    /// Join ``room``, publishing the mic during the join so the publisher
    /// peer connection rides the initial negotiation — unless ``micMuted``,
    /// where the privacy contract is to join without publishing audio (the
    /// track first publishes on ``setMicrophoneEnabled(true)``). Bounded by
    /// ``options.connectTimeout``; throws ``SessionStartFailure``.
    private func _joinRoom(
        _ room: Room,
        url: String,
        token: String,
        micMuted: Bool
    ) async throws {
        do {
            try await _withConnectTimeout(
                seconds: options.connectTimeout,
                operation: {
                    try await room.connect(
                        url: url,
                        token: token,
                        connectOptions: ConnectOptions(enableMicrophone: !micMuted)
                    )
                },
                onLateSettlement: { [room] in
                    await room.disconnect()
                }
            )
        } catch RealtimeError.connectTimeout {
            throw SessionStartFailure.transport(
                message: "LiveKit Room.connect timed out after \(options.connectTimeout)s"
            )
        } catch {
            throw SessionStartFailure.transport(message: error.localizedDescription)
        }
    }

    func send(frame: Data) async throws {
        guard let room else { throw RealtimeSessionError.notConnected }
        // Retry over the DTLS-handshake race: only the literal
        // "Data channel is not open" retries, with 50ms-doubling backoff.
        let maxAttempts = 5
        var lastError: Error?
        for attempt in 0..<maxAttempts {
            do {
                try await room.localParticipant.publish(
                    data: frame,
                    options: DataPublishOptions(reliable: true)
                )
                return
            } catch {
                lastError = error
                let isTransient = error.localizedDescription.contains("Data channel is not open")
                if isTransient && attempt < maxAttempts - 1 {
                    try? await Task.sleep(nanoseconds: 50_000_000 << attempt)
                    continue
                }
                throw error
            }
        }
        if let lastError { throw lastError }
    }

    func sendBytes(_ data: Data, topic: String) async throws {
        guard let room else { throw RealtimeSessionError.notConnected }
        // A byte stream needs explicit destinations; target the agent only.
        let agentIdentities = room.remoteParticipants.values
            .filter { $0.kind == .agent }
            .compactMap(\.identity)
        guard !agentIdentities.isEmpty else { throw RealtimeSessionError.notConnected }
        let writer = try await room.localParticipant.streamBytes(
            options: StreamByteOptions(topic: topic, destinationIdentities: agentIdentities)
        )
        do {
            try await writer.write(data)
        } catch {
            try? await writer.close()
            throw error
        }
        try await writer.close()
    }

    func setMicrophoneEnabled(_ enabled: Bool) async throws {
        guard let room else { return }
        do {
            let publication = try await room.localParticipant.setMicrophone(enabled: enabled)
            // A session that joined muted (``micMuted``) publishes its mic here
            // for the first time; attach the input tap so the waveform lights
            // up once audio flows.
            if enabled, let micTrack = publication?.track as? LocalAudioTrack {
                await attachMicInstrumentation(to: micTrack)
            }
        } catch {
            // Surface, don't swallow: for a muted join this is the first-ever
            // publish, so a denied-permission failure must reach ``setMuted``
            // instead of reporting a false success while nothing is published.
            Self.log.error("setMicrophone(enabled: \(enabled, privacy: .public)) failed: \(error.localizedDescription, privacy: .public)")
            throw error
        }
    }

    /// Wire a freshly-published local mic track into the input-level tap so
    /// the waveform lights up once audio flows. Shared by the connect-time
    /// publish and the first ``setMicrophoneEnabled(true)`` of a muted join.
    /// The agent-audio tap is attached separately by the delegate once that
    /// track is subscribed (it may not exist yet at connect time). Idempotent
    /// on a re-enable — ``attachInputLevelTap`` swaps the renderer off any
    /// prior track.
    private func attachMicInstrumentation(to track: LocalAudioTrack) async {
        attachInputLevelTap(to: track)
    }

    func close() async {
        isClosed.withLock { $0 = true }
        framePump?.cancel()
        framePump = nil
        roomDelegate?.finishFrames()
        detachInputLevelTap()
        detachOutputLevelTap()
        inputLevelContinuation.finish()
        outputLevelContinuation.finish()
        screenShareLock.withLock { state in
            state?.publishTask?.cancel()
            state = nil
        }
        stopAudioStreamSlot()
        if let room {
            await room.disconnect()
        }
        room = nil
        roomDelegate = nil
    }

    // MARK: Audio level taps
    //
    // The taps are LiveKit ``AudioRenderer``s: added to a track, LiveKit
    // drives ``render`` off its audio render callback (no timer here), and
    // ``AudioLevelTap`` self-throttles emits to ~30 Hz. Detach happens on
    // track teardown and at ``close()``.

    nonisolated func attachInputLevelTap(to track: LocalAudioTrack) {
        // Drop the renderer from any prior track before attaching, so a
        // re-attach never leaves a renderer wired to a stale track.
        let previous = attachedLocalTrack.withLock { current -> LocalAudioTrack? in
            let prior = current
            current = track
            return prior
        }
        if let previous, previous !== track {
            previous.remove(audioRenderer: inputLevelTap)
        }
        track.add(audioRenderer: inputLevelTap)
    }

    nonisolated func detachInputLevelTap() {
        if let track = attachedLocalTrack.withLock({ current -> LocalAudioTrack? in
            let t = current
            current = nil
            return t
        }) {
            track.remove(audioRenderer: inputLevelTap)
        }
    }

    /// Make a newly-subscribed agent-audio track the current output tap.
    nonisolated func beginAgentAudio(track: RemoteAudioTrack, sid: Track.Sid) {
        attachOutputLevelTap(to: track, sid: sid)
    }

    nonisolated func attachOutputLevelTap(to track: RemoteAudioTrack, sid: Track.Sid) {
        // Swap in the new track and drop the renderer from any prior one,
        // so a re-attach (the agent republishing its audio) never leaves a
        // renderer wired to a stale track.
        let previous = attachedRemoteTrack.withLock { current -> RemoteAudioTrack? in
            let prior = current?.track
            current = (sid, track)
            return prior
        }
        if let previous, previous !== track {
            previous.remove(audioRenderer: outputLevelTap)
        }
        track.add(audioRenderer: outputLevelTap)
        // A late-attaching track inherits the current desired gain — otherwise
        // a host that silenced the agent via playback volume would hear it
        // again the moment the agent republishes its audio (or reconnects).
        track.volume = desiredAgentVolume.withLock { $0 }
    }

    /// Software playback gain for the agent's audio: `0` mutes, `1` is unity.
    /// Values outside 0…1 are clamped. Stored so a track attaching later
    /// (late agent join, reconnect) inherits it; applied immediately to the
    /// currently-subscribed agent track. Nonisolated + lock-guarded so a host
    /// can drive it from an `AVAudioSession.outputVolume` KVO callback.
    nonisolated func setAgentPlaybackVolume(_ volume: Double) {
        let clamped = min(max(volume, 0), 1)
        desiredAgentVolume.withLock { $0 = clamped }
        attachedRemoteTrack.withLock { $0 }?.track.volume = clamped
    }

    /// Unconditional detach (used at ``close()``).
    nonisolated func detachOutputLevelTap() {
        if let track = attachedRemoteTrack.withLock({ current -> RemoteAudioTrack? in
            let t = current?.track
            current = nil
            return t
        }) {
            track.remove(audioRenderer: outputLevelTap)
        }
    }

    /// Resolve an agent-audio unsubscribe of ``sid``: detach the output tap
    /// iff this SID owns it. Keyed on publication SID, not
    /// ``publication.track`` — LiveKit nils that before it notifies unsubscribe
    /// on the ``didRemoveTrack`` / ``set(subscribed:)`` paths, so reading it
    /// there would skip cleanup. An overlapping republish already swapped the
    /// tap off in ``attachOutputLevelTap``, so a stale SID is a no-op.
    nonisolated func endAgentAudio(publicationSID sid: Track.Sid) {
        let tappedTrack = attachedRemoteTrack.withLock { current -> RemoteAudioTrack? in
            guard let c = current, c.sid == sid else { return nil }
            current = nil
            return c.track
        }
        tappedTrack?.remove(audioRenderer: outputLevelTap)
    }

    /// Phase breakdown of one connect: ``ws`` is the REST session-start,
    /// ``room`` the LiveKit join, ``mic`` the mic-publish duration (0 for a
    /// muted join, which publishes nothing), ``total`` the whole connect
    /// through connect-ready.
    ///
    /// The phases do NOT necessarily sum to ``total``. On the prepared-room
    /// fast path the REST start runs concurrently with the join, so
    /// ``joinStartedAt`` precedes ``restDoneAt`` and the ws/room windows
    /// overlap. Pure so that property is testable without a server.
    static func connectPhases(
        handshakeStart: Date,
        restDoneAt: Date,
        joinStartedAt: Date,
        roomConnectedAt: Date,
        connectReadyAt: Date,
        micMs: Double
    ) -> (wsMs: Double, roomMs: Double, micMs: Double, totalMs: Double) {
        (
            wsMs: restDoneAt.timeIntervalSince(handshakeStart) * 1000,
            roomMs: roomConnectedAt.timeIntervalSince(joinStartedAt) * 1000,
            micMs: micMs,
            totalMs: connectReadyAt.timeIntervalSince(handshakeStart) * 1000
        )
    }

    /// Register every client-tool RPC method (inline + background) on
    /// ``room``. Runs pre-join — LiveKit binds RPC handlers on room-local
    /// state, no connection required. A binding failure fails the start: the
    /// tools are already advertised in ``session-config``, so starting
    /// without a local handler would let the agent call a tool that always
    /// errors.
    static func bindClientTools(
        on room: Room,
        clientToolHandlers: [String: ClientToolHandler],
        backgroundClientToolHandlers: [String: BackgroundClientToolHandler],
        clientToolJobSink: ClientToolJobSink?,
        hooks: HookEngine?,
        sessionId: @escaping @Sendable () async -> String?
    ) async throws {
        try await registerClientToolHandlers(
            on: room,
            handlers: clientToolHandlers,
            hooks: hooks,
            sessionId: sessionId
        )
        if let clientToolJobSink, !backgroundClientToolHandlers.isEmpty {
            try await registerBackgroundClientToolHandlers(
                on: room,
                handlers: backgroundClientToolHandlers,
                sink: clientToolJobSink,
                hooks: hooks,
                sessionId: sessionId
            )
        }
    }

    /// A ``MintTokenError`` raised while resolving the credential travels
    /// through the generated client wrapped in a ``ClientError``; recover
    /// it so the token-source failure (and its slug) survives to the caller.
    static func _mintTokenError(in error: any Error) -> MintTokenError? {
        if let mintError = error as? MintTokenError { return mintError }
        if let clientError = error as? ClientError,
           let mintError = clientError.underlyingError as? MintTokenError {
            return mintError
        }
        return nil
    }

    /// POST ``/session/start`` and decode the response. Static
    /// (captures only the Sendable ``Client``) so the prepared fast path can
    /// run it in a parallel task while the room join proceeds.
    private static func _callStart(
        client: CosmoRealtimeAPI.Client,
        config: CosmoRealtimeAPI.Components.Schemas.SessionConfig
    ) async throws -> CosmoRealtimeAPI.Components.Schemas.SessionResponse {
        let output: CosmoRealtimeAPI.Operations.StartRealtimeSession.Output
        do {
            output = try await client.startRealtimeSession(body: .json(config))
        } catch {
            if let mintError = _mintTokenError(in: error) {
                throw SessionStartFailure.credential(mintError)
            }
            throw SessionStartFailure.transport(message: error.localizedDescription)
        }
        switch output {
        case .ok(let ok):
            do {
                return try ok.body.json
            } catch {
                throw SessionStartFailure.transport(
                    message: "session-start response decode failed: \(error.localizedDescription)"
                )
            }
        case .unauthorized(let err):
            // Auth-layer 401: the body is ``{"detail": "..."}`` — never the
            // error envelope — so there is no rejection code to parse.
            throw SessionStartFailure.rejected(
                status: 401, code: nil, detail: (try? err.body.json.detail) ?? "Unauthorized"
            )
        case .unprocessableContent(let err):
            guard let envelope = try? err.body.json else {
                throw SessionStartFailure.rejected(
                    status: 422, code: nil, detail: "Unprocessable content"
                )
            }
            throw SessionStartFailure.rejected(
                status: 422, code: envelope.error.code, detail: envelope.error.message
            )
        case .undocumented(let statusCode, let payload):
            let body = await Self._collectBody(payload)
            let detail = body.isEmpty ? "HTTP \(statusCode)" : "HTTP \(statusCode): \(body)"
            throw SessionStartFailure.rejected(status: statusCode, code: rejectionCode(inBody: body), detail: detail)
        }
    }

    private static func _collectBody(_ payload: OpenAPIRuntime.UndocumentedPayload) async -> String {
        guard let body = payload.body else { return "" }
        return (try? await String(collecting: body, upTo: 64 * 1024)) ?? ""
    }
}

/// Minimal ``RoomDelegate`` for the session transport: forwards data
/// packets (in arrival order, via the frame stream) and maps transport
/// lifecycle onto the session callbacks. Lifecycle callbacks are
/// chained FIFO so LiveKit's multi-queue delivery can't reorder them.
final class SessionRoomDelegate: RoomDelegate, @unchecked Sendable {

    private let frames: AsyncStream<Data>.Continuation
    private let callbacks: SessionTransportCallbacks
    // The transport owns the level taps; the delegate attaches the agent
    // audio tap once that track is subscribed. Weak so the delegate never
    // outlives the transport it reports to. Tap attach/detach are
    // ``nonisolated`` lock-only calls — safe to invoke from LiveKit's
    // delegate queue without hopping the actor.
    private weak var transport: LiveKitSessionTransport?

    private let chainLock = NSLock()
    private var lastTask: Task<Void, Never>?
    // Fire the agent-live readiness signal at most once, on the agent's first
    // published track. Lock-guarded: LiveKit delivers delegate callbacks
    // serially, but the delegate is ``@unchecked Sendable``.
    private let agentLiveSignaled = OSAllocatedUnfairLock<Bool>(initialState: false)

    init(
        frames: AsyncStream<Data>.Continuation,
        callbacks: SessionTransportCallbacks,
        transport: LiveKitSessionTransport
    ) {
        self.frames = frames
        self.callbacks = callbacks
        self.transport = transport
    }

    func finishFrames() {
        frames.finish()
    }

    private func enqueue(_ work: @escaping @Sendable () async -> Void) {
        chainLock.lock()
        let prev = lastTask
        let next = Task {
            await prev?.value
            await work()
        }
        lastTask = next
        chainLock.unlock()
    }

    func room(
        _ room: Room,
        participant: RemoteParticipant?,
        didReceiveData data: Data,
        forTopic topic: String,
        encryptionType: EncryptionType
    ) {
        // Protocol frames come only from the agent; drop a room peer's packets
        // (a SIP leg, another client). ``participant`` is nil for server-API
        // data, which no peer can forge — let it through.
        if let participant, !participant.isAgent {
            LiveKitSessionTransport.log.warning("data frame from non-agent participant dropped sender=\(String(describing: participant.identity), privacy: .public)")
            return
        }
        frames.yield(data)
    }

    func room(
        _ room: Room,
        didUpdateConnectionState connectionState: LiveKit.ConnectionState,
        from oldConnectionState: LiveKit.ConnectionState
    ) {
        switch connectionState {
        case .connected:
            // The initial join is reported by ``connect`` itself; only
            // surface recoveries.
            if case .reconnecting = oldConnectionState {
                enqueue { [callbacks] in await callbacks.onReconnected() }
            }
        case .reconnecting:
            enqueue { [callbacks] in await callbacks.onReconnecting() }
        case .disconnected:
            frames.finish()
            let reason = endReason(
                forDisconnectType: room.disconnectError?.type,
                message: room.disconnectError?.localizedDescription
            )
            enqueue { [callbacks, weak transport] in
                await transport?.awaitFramePumpDrained()
                await callbacks.onClosed(reason)
            }
        default:
            break
        }
    }

    func room(_ room: Room, didDisconnectWithError error: LiveKitError?) {
        frames.finish()
        let reason = endReason(
            forDisconnectType: error?.type,
            message: error?.localizedDescription
        )
        enqueue { [callbacks, weak transport] in
            await transport?.awaitFramePumpDrained()
            await callbacks.onClosed(reason)
        }
    }

    // Agent audio track lifecycle drives the ``outputLevels`` tap: attach
    // once the remote agent's audio track is subscribed, detach when it
    // goes away. Tap calls are synchronous lock-only operations on the
    // transport, so they run inline.
    func room(_ room: Room, participant: RemoteParticipant, didSubscribeTrack publication: RemoteTrackPublication) {
        guard participant.isAgent, let track = publication.track as? RemoteAudioTrack else { return }
        let sid = publication.sid
        transport?.beginAgentAudio(track: track, sid: sid)
        // The agent published its track: LiveKit's race-free "agent is live"
        // signal. Fire onAgentLive once (independent of the server `ready`
        // frame, which may be lost to the pre-data-channel broadcast race). On
        // the same serial chain as onFrame so it can't be reordered ahead of a
        // `ready` frame that arrived just before.
        let firstAgentTrack = agentLiveSignaled.withLock { signaled -> Bool in
            guard !signaled else { return false }
            signaled = true
            return true
        }
        if firstAgentTrack {
            enqueue { [callbacks] in await callbacks.onAgentLive() }
        }
    }

    func room(_ room: Room, participant: RemoteParticipant, didUnsubscribeTrack publication: RemoteTrackPublication) {
        // Keyed on publication SID, not ``publication.track`` — LiveKit nils
        // that before notifying on the ``didRemoveTrack`` /
        // ``set(subscribed:)`` paths. A non-agent-audio unsubscribe is a no-op.
        transport?.endAgentAudio(publicationSID: publication.sid)
    }
}

/// Classify a LiveKit disconnect into the session's end reason. Deliberate
/// server-side closes map to ``RealtimeSession/EndReason/serverEnded(reason:)``;
/// everything else — including ``serverShutdown``, infrastructure failure from
/// the caller's perspective — stays ``transportError``. Same mapping as the
/// sibling SDKs, with one platform gap: client-sdk-swift has no error
/// type for proto ``ROOM_CLOSED`` (it arrives as ``.unknown``), so that reason
/// remains a transport error here.
func endReason(
    forDisconnectType type: LiveKitErrorType?,
    message: String?
) -> RealtimeSession.EndReason {
    switch type {
    case .roomDeleted:
        return .serverEnded(reason: "ROOM_DELETED")
    case .participantRemoved:
        return .serverEnded(reason: "PARTICIPANT_REMOVED")
    default:
        return .transportError(message: message ?? "LiveKit room disconnected")
    }
}
