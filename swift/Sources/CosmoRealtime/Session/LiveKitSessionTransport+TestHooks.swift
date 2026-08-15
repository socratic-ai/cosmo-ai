#if DEBUG
import Foundation
import LiveKit

/// Test-only hooks (DEBUG-only) for the screen-share lock state machine.
/// Drive synthetic transitions without a real LiveKit Room.
extension LiveKitSessionTransport {

    /// Inject a synthetic ``ScreenShareState`` so the post-failure
    /// recovery path can be unit-tested without a real publish (which
    /// needs a connected SFU). ``LocalVideoTrack.createBufferTrack`` runs
    /// offline — it allocates the capturer without contacting a server.
    /// Returns the installed state so a test can capture its identity
    /// (replacing it with a second wedge exercises the stop+restart
    /// identity guard). Each call replaces any existing state.
    @discardableResult
    func _testInjectScreenShareWedge() -> ScreenShareState? {
        let track = LocalVideoTrack.createBufferTrack(
            name: "test-screenshare",
            source: .screenShareVideo,
            options: BufferCaptureOptions()
        )
        guard let capturer = track.capturer as? BufferCapturer else { return nil }
        let state = ScreenShareState(track: track, capturer: capturer)
        screenShareLock.withLock { $0 = state }
        return state
    }

    /// Whether ``screenShareLock`` currently holds any state.
    func _testScreenShareLockHasValue() -> Bool {
        screenShareLock.withLock { $0 != nil }
    }

    /// Install an unconnected ``Room`` so the start-path ``room != nil``
    /// guard passes offline. Track creation runs without a server; the
    /// deferred publish only fires on the first pushed frame, which these
    /// tests never send.
    func _testInstallDetachedRoom() {
        room = Room(roomOptions: RoomOptions())
    }

    /// The state currently held by ``screenShareLock`` (for identity
    /// comparison in the stop+restart guard test).
    func _testCurrentScreenShareState() -> ScreenShareState? {
        screenShareLock.withLock { $0 }
    }

    /// Mark the transport closed so the deferred-publish ``isClosed``
    /// guard can be exercised without a real teardown.
    func _testMarkClosed() {
        isClosed.withLock { $0 = true }
    }

    /// Whether ``audioStreamLock`` currently holds any state.
    nonisolated func _testAudioStreamLockHasValue() -> Bool {
        audioStreamLock.withLock { $0 != nil }
    }

    /// Connect the transport's room directly to a LiveKit ``Room`` with a
    /// pre-minted token, bypassing the REST session-start. Used by E2E
    /// tests that talk to a local ``livekit-server`` in dev mode so the
    /// screen-share publish path can be exercised against a real SFU.
    ///
    /// Pass ``attachDelegate: true`` to wire the production
    /// ``SessionRoomDelegate`` (with no-op transport callbacks) so remote
    /// track subscribe/unsubscribe events — e.g. the agent-audio tap
    /// lifecycle — flow through the same handlers production uses.
    func _connectRoomForTest(url: String, token: String, attachDelegate: Bool = false) async throws {
        let newRoom = Room(roomOptions: RoomOptions(adaptiveStream: true, dynacast: true))
        if attachDelegate {
            let frameStream = AsyncStream<Data>.makeStream(bufferingPolicy: .unbounded)
            let delegate = SessionRoomDelegate(
                frames: frameStream.continuation,
                callbacks: SessionTransportCallbacks(
                    onFrame: { _ in },
                    onClosed: { _ in },
                    onReconnecting: {},
                    onReconnected: {},
                    onAgentLive: {}
                ),
                transport: self
            )
            newRoom.delegates.add(delegate: delegate)
            // LiveKit stores delegates weakly — retain it or the callbacks
            // never fire (production keeps it in ``roomDelegate`` too).
            self.roomDelegate = delegate
        }
        try await newRoom.connect(url: url, token: token)
        self.room = newRoom
    }

    /// Whether the agent-audio output-level tap is currently attached — a
    /// proxy for "an agent ``RemoteAudioTrack`` is subscribed", set by
    /// ``didSubscribeTrack`` and cleared by ``didUnsubscribeTrack`` (the same
    /// handler that detaches the track's output tap).
    nonisolated func _testHasOutputLevelTap() -> Bool {
        attachedRemoteTrack.withLock { $0 != nil }
    }

    /// Force the subscriber-side ``set(subscribed: false)`` unsubscribe, which
    /// nils ``publication.track`` before notifying ``didUnsubscribeTrack`` —
    /// the exact path ``endAgentAudio(publicationSID:)`` must handle by SID. Unsubscribes
    /// every subscribed agent-audio publication the room currently holds.
    func _testForceUnsubscribeAgentAudio() async throws {
        guard let room else { return }
        for participant in room.remoteParticipants.values where participant.isAgent {
            for publication in participant.audioTracks.compactMap({ $0 as? RemoteTrackPublication }) {
                try await publication.set(subscribed: false)
            }
        }
    }

    /// Tear down a room established via ``_connectRoomForTest``.
    func _disconnectRoomForTest() async {
        await close()
    }

    /// Push a synthetic RMS value into the ``inputLevels`` /
    /// ``outputLevels`` continuations, bypassing the ``AudioLevelTap`` /
    /// real track that needs audio hardware. Lets the passthrough wiring
    /// (transport → ``RealtimeSession``) be exercised offline.
    nonisolated func _testEmitInputLevel(_ value: Float) {
        inputLevelContinuation.yield(value)
    }

    nonisolated func _testEmitOutputLevel(_ value: Float) {
        outputLevelContinuation.yield(value)
    }
}
#endif
