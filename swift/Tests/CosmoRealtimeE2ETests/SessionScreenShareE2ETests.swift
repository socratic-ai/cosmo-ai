import CoreMedia
import CoreVideo
import Foundation
import LiveKit
import Testing
@testable import CosmoRealtime

/// Screen-share publish path on ``LiveKitSessionTransport``
/// against a real ``livekit-server`` in dev mode. Skipped unless
/// ``LIVEKIT_TESTING_URL`` is set; this suite does not run in the
/// offline build.
// Serialized: every test connects one or more real rooms to the shared dev
// livekit-server. Run in parallel (swift-testing's default), the simultaneous
// connects storm the server and intermittently time out (LiveKit code 101).
@Suite("Session screen-share E2E", .enabled(if: E2EFixture.isConfigured), .serialized)
struct SessionScreenShareE2ETests {

    private func makeTransport() -> LiveKitSessionTransport {
        LiveKitSessionTransport(
            options: RealtimeSession.Options(
                apiKey: "n/a"
            )
        )
    }

    @Test("startScreenShare without a connected room throws .notConnected")
    func startWithoutRoomThrows() async throws {
        let transport = makeTransport()

        await #expect(throws: RealtimeSessionError.notConnected) {
            try await transport.startScreenShare()
        }
        #expect(!(await transport._testScreenShareLockHasValue()), "guard must reject before installing state")
    }

    @Test("pushScreenShareFrame triggers a deferred publish that installs a publication")
    func pushFrameTriggersPublish() async throws {
        let fixture = try E2EFixture.requireE2EServer()
        let roomName = "e2e-session-screenshare-\(UUID().uuidString.prefix(8))"
        let tokenA = try TokenGenerator(
            apiKey: fixture.apiKey,
            apiSecret: fixture.apiSecret,
            identity: "peer-a",
            room: roomName
        ).sign()
        let tokenB = try TokenGenerator(
            apiKey: fixture.apiKey,
            apiSecret: fixture.apiSecret,
            identity: "peer-b",
            room: roomName
        ).sign()

        let peerA = makeTransport()
        let peerB = makeTransport()

        try await peerA._connectRoomForTest(url: fixture.serverURL, token: tokenA)
        try await peerB._connectRoomForTest(url: fixture.serverURL, token: tokenB)

        // start installs the BufferCapturer + LocalVideoTrack but does
        // NOT publish to the SFU yet — that waits on first frame so
        // dimensions are resolvable.
        try await peerA.startScreenShare()
        #expect(await peerA._testScreenShareLockHasValue(), "startScreenShare must install ScreenShareState")

        // The deferred publish task only needs one capture to resolve
        // dimensions; push a few more to keep the capturer fed while it
        // negotiates with the SFU.
        peerA.pushScreenShareFrame(try makeBlankSampleBuffer())
        for _ in 0..<5 {
            try? await Task.sleep(nanoseconds: 100_000_000)
            peerA.pushScreenShareFrame(try makeBlankSampleBuffer())
        }

        var publishedOK = false
        for _ in 0..<40 {
            let pubInstalled = peerA.screenShareLock.withLock { $0?.publication != nil }
            if pubInstalled {
                publishedOK = true
                break
            }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        #expect(publishedOK, "deferred publish task must install a publication after first frame")

        await peerA.stopScreenShare()
        #expect(!(await peerA._testScreenShareLockHasValue()), "stopScreenShare must clear the lock")

        await peerA._disconnectRoomForTest()
        await peerB._disconnectRoomForTest()
    }

    @Test("publish then immediate stop tears down cleanly with the stats path")
    func stopAfterPublishTearsDownCleanly() async throws {
        // Integration smoke for the screen-share stop path: a real publish arms
        // LiveKit's ~1 Hz per-track stats timer; stop disables it before
        // unpublishing (see ``stopScreenShare``). Publish for real, stop as soon
        // as the publication lands (the tightest window against the
        // publish-completion reconciliation), then let two timer intervals
        // elapse with the room connected. This exercises the enable→disable→
        // unpublish ordering against a real SFU. It is NOT a crash regression:
        // the WebRTC abort the fix prevents does not reproduce on the local dev
        // server (the ordering itself is what the offline reconcile tests lock).
        let fixture = try E2EFixture.requireE2EServer()
        let token = try fixture.mintToken()
        let transport = makeTransport()
        try await transport._connectRoomForTest(url: fixture.serverURL, token: token.token)

        try await transport.startScreenShare()
        transport.pushScreenShareFrame(try makeBlankSampleBuffer())

        var published = false
        for _ in 0..<40 {
            if transport.screenShareLock.withLock({ $0?.publication != nil }) {
                published = true
                break
            }
            try? await Task.sleep(nanoseconds: 100_000_000)
            transport.pushScreenShareFrame(try makeBlankSampleBuffer())
        }
        #expect(published, "deferred publish must install a publication before we stop")

        await transport.stopScreenShare()
        #expect(!(await transport._testScreenShareLockHasValue()), "stop must clear screen-share state")

        // Two full 1 Hz stats intervals: a leaked timer would have ticked (and
        // aborted) well within this window.
        try await Task.sleep(nanoseconds: 2_500_000_000)

        await transport._disconnectRoomForTest()
    }

    @Test("agent-audio subscribe/unsubscribe lifecycle runs cleanly mid-call")
    func agentAudioSubscribeUnsubscribeLifecycle() async throws {
        // Integration smoke for the agent-audio QoE path exercised by
        // ``didSubscribeTrack`` / ``didUnsubscribeTrack``: an agent-kind peer
        // publishes audio, the transport subscribes (tap attaches, QoE stats
        // armed), the agent unpublishes mid-call (tap detaches, stats disabled),
        // and two stats intervals elapse with the room still connected. This
        // proves the lifecycle wiring runs end-to-end against a real SFU. It is
        // NOT a crash regression: the receiver-side WebRTC abort does not
        // reproduce on the local dev server (see the fix comment in
        // ``didUnsubscribeTrack``); the disable there is verified by reasoning
        // and the energy invariant, not by this test aborting.
        let fixture = try E2EFixture.requireE2EServer()
        let roomName = "e2e-agent-audio-\(UUID().uuidString.prefix(8))"
        let subToken = try TokenGenerator(
            apiKey: fixture.apiKey, apiSecret: fixture.apiSecret,
            identity: "subscriber", room: roomName
        ).sign()
        let agentToken = try TokenGenerator(
            apiKey: fixture.apiKey, apiSecret: fixture.apiSecret,
            identity: "agent", room: roomName, isAgent: true
        ).sign()

        // The transport under test subscribes; the delegate must be wired so
        // subscribe/unsubscribe drive the QoE lifecycle production runs.
        let subscriber = makeTransport()
        try await subscriber._connectRoomForTest(
            url: fixture.serverURL, token: subToken, attachDelegate: true
        )
        // The agent joins as a raw room and publishes audio. The dev server's
        // signaling connect is occasionally slow under back-to-back E2E joins,
        // so retry the connect a few times before giving up.
        let agent = Room(roomOptions: RoomOptions(adaptiveStream: true, dynacast: true))
        var connectError: Error?
        for attempt in 0..<3 {
            do {
                try await agent.connect(url: fixture.serverURL, token: agentToken)
                connectError = nil
                break
            } catch {
                connectError = error
                if attempt < 2 { try? await Task.sleep(nanoseconds: 500_000_000) }
            }
        }
        if let connectError { throw connectError }

        let audioTrack = LocalAudioTrack.createTrack()
        let publication = try await agent.localParticipant.publish(audioTrack: audioTrack)

        // Subscribe is async over the SFU; the tap attaches once the agent
        // audio track lands on the subscriber (proves stats were enabled).
        var attached = false
        for _ in 0..<50 {
            if subscriber._testHasOutputLevelTap() { attached = true; break }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        #expect(attached, "subscriber must attach the agent-audio tap (QoE stats enabled) before unsubscribe")

        // Unpublish mid-call — room stays connected, so LiveKit does NOT cancel
        // the stats timer; only ``didUnsubscribeTrack`` disabling it does.
        try await agent.localParticipant.unpublish(publication: publication)

        var detached = false
        for _ in 0..<50 {
            if !subscriber._testHasOutputLevelTap() { detached = true; break }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        #expect(detached, "unsubscribe must detach the tap (and run the stats-disable path)")

        // Let two 1 Hz stats intervals elapse with the room connected so the
        // subscribe→publish→unsubscribe cycle settles without error.
        try await Task.sleep(nanoseconds: 2_500_000_000)

        await agent.disconnect()
        await subscriber._disconnectRoomForTest()
    }

    @Test("agent-audio cleanup runs when LiveKit nils the publication track first")
    func agentAudioUnsubscribeViaSetSubscribedStillCleansUp() async throws {
        // Regression for the ``set(track: nil)`` unsubscribe path: LiveKit clears
        // ``publication.track`` BEFORE notifying ``didUnsubscribeTrack`` when a
        // subscription is dropped via ``set(subscribed: false)`` (and on SFU
        // ``didRemoveTrack``). A handler that reads ``publication.track`` sees
        // nil and skips cleanup, leaking the tap + QoE stats timer. This drives
        // exactly that path and asserts the tap still detaches — it fails
        // against a ``publication.track``-based handler and passes against the
        // SID-keyed one.
        let fixture = try E2EFixture.requireE2EServer()
        let roomName = "e2e-agent-audio-nil-\(UUID().uuidString.prefix(8))"
        let subToken = try TokenGenerator(
            apiKey: fixture.apiKey, apiSecret: fixture.apiSecret,
            identity: "subscriber", room: roomName
        ).sign()
        let agentToken = try TokenGenerator(
            apiKey: fixture.apiKey, apiSecret: fixture.apiSecret,
            identity: "agent", room: roomName, isAgent: true
        ).sign()

        let subscriber = makeTransport()
        try await subscriber._connectRoomForTest(
            url: fixture.serverURL, token: subToken, attachDelegate: true
        )
        let agent = Room(roomOptions: RoomOptions(adaptiveStream: true, dynacast: true))
        var connectError: Error?
        for attempt in 0..<3 {
            do { try await agent.connect(url: fixture.serverURL, token: agentToken); connectError = nil; break }
            catch { connectError = error; if attempt < 2 { try? await Task.sleep(nanoseconds: 500_000_000) } }
        }
        if let connectError { throw connectError }

        let audioTrack = LocalAudioTrack.createTrack()
        _ = try await agent.localParticipant.publish(audioTrack: audioTrack)

        var attached = false
        for _ in 0..<50 {
            if subscriber._testHasOutputLevelTap() { attached = true; break }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        #expect(attached, "subscriber must attach the agent-audio tap before unsubscribe")

        // Drop the subscription — nils publication.track, then notifies.
        try await subscriber._testForceUnsubscribeAgentAudio()

        var detached = false
        for _ in 0..<50 {
            if !subscriber._testHasOutputLevelTap() { detached = true; break }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        #expect(detached, "cleanup must run on the nil-publication-track unsubscribe path")

        await agent.disconnect()
        await subscriber._disconnectRoomForTest()
    }

    @Test("a stale agent-audio unsubscribe leaves the republished track's tap attached")
    func agentAudioOverlappingRepublishKeepsCurrentTap() async throws {
        // Overlapping republish: the agent publishes a NEW audio track before
        // the OLD one unsubscribes, so the output tap moves to the new track.
        // The old publication's later unsubscribe must NOT tear down the tap
        // that has already moved on — cleanup is keyed on publication SID, so
        // a stale SID is a no-op. Fails against a handler that detaches the
        // single tap slot unconditionally.
        let fixture = try E2EFixture.requireE2EServer()
        let roomName = "e2e-agent-audio-overlap-\(UUID().uuidString.prefix(8))"
        let subToken = try TokenGenerator(
            apiKey: fixture.apiKey, apiSecret: fixture.apiSecret,
            identity: "subscriber", room: roomName
        ).sign()
        let agentToken = try TokenGenerator(
            apiKey: fixture.apiKey, apiSecret: fixture.apiSecret,
            identity: "agent", room: roomName, isAgent: true
        ).sign()

        let subscriber = makeTransport()
        try await subscriber._connectRoomForTest(
            url: fixture.serverURL, token: subToken, attachDelegate: true
        )
        let agent = Room(roomOptions: RoomOptions(adaptiveStream: true, dynacast: true))
        var connectError: Error?
        for attempt in 0..<3 {
            do { try await agent.connect(url: fixture.serverURL, token: agentToken); connectError = nil; break }
            catch { connectError = error; if attempt < 2 { try? await Task.sleep(nanoseconds: 500_000_000) } }
        }
        if let connectError { throw connectError }

        // Two concurrent agent-audio publications (models an overlapping
        // republish: both subscribed before either unsubscribes). The tap
        // follows the most recent subscribe.
        let pub1 = try await agent.localParticipant.publish(audioTrack: LocalAudioTrack.createTrack())
        _ = try await agent.localParticipant.publish(audioTrack: LocalAudioTrack.createTrack())

        var tapped = false
        for _ in 0..<50 {
            if subscriber._testHasOutputLevelTap() { tapped = true; break }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        #expect(tapped, "an agent-audio subscribe must attach the output tap")

        // Unpublish the first — it is no longer the current output tap.
        try await agent.localParticipant.unpublish(publication: pub1)

        // Give the unsubscribe time to land, then assert the tap SURVIVED.
        try? await Task.sleep(nanoseconds: 1_000_000_000)
        #expect(subscriber._testHasOutputLevelTap(),
                "a stale publication's unsubscribe must not detach the current tap")

        await agent.disconnect()
        await subscriber._disconnectRoomForTest()
    }

    @Test("stopScreenShare is idempotent — second call is a safe no-op")
    func stopIsIdempotent() async throws {
        let fixture = try E2EFixture.requireE2EServer()
        let token = try fixture.mintToken()
        let transport = makeTransport()
        try await transport._connectRoomForTest(url: fixture.serverURL, token: token.token)

        try await transport.startScreenShare()
        #expect(await transport._testScreenShareLockHasValue())

        transport.pushScreenShareFrame(try makeBlankSampleBuffer())

        await transport.stopScreenShare()
        #expect(!(await transport._testScreenShareLockHasValue()), "stopScreenShare must clear state")

        await transport.stopScreenShare()
        #expect(!(await transport._testScreenShareLockHasValue()), "second stopScreenShare must remain a no-op")

        await transport._disconnectRoomForTest()
    }

    @Test("startScreenShare twice in a row replaces the prior session")
    func startIsIdempotent() async throws {
        let fixture = try E2EFixture.requireE2EServer()
        let token = try fixture.mintToken()
        let transport = makeTransport()
        try await transport._connectRoomForTest(url: fixture.serverURL, token: token.token)

        try await transport.startScreenShare()
        #expect(await transport._testScreenShareLockHasValue())

        try await transport.startScreenShare()
        #expect(await transport._testScreenShareLockHasValue(),
                "second startScreenShare must leave a fresh state installed")

        await transport.stopScreenShare()
        await transport._disconnectRoomForTest()
    }
}

// MARK: - Helpers

/// Create a single blank 320x240 BGRA ``CMSampleBuffer`` suitable for
/// feeding into ``pushScreenShareFrame``. The publish path only needs
/// resolvable dimensions; pixel contents are irrelevant.
private func makeBlankSampleBuffer(
    width: Int = 320,
    height: Int = 240
) throws -> CMSampleBuffer {
    var pixelBuffer: CVPixelBuffer?
    let status = CVPixelBufferCreate(
        kCFAllocatorDefault,
        width,
        height,
        kCVPixelFormatType_32BGRA,
        [
            kCVPixelBufferIOSurfacePropertiesKey as String: [:] as CFDictionary
        ] as CFDictionary,
        &pixelBuffer
    )
    guard status == kCVReturnSuccess, let pb = pixelBuffer else {
        throw NSError(
            domain: "SessionScreenShareE2ETests",
            code: Int(status),
            userInfo: [NSLocalizedDescriptionKey: "CVPixelBufferCreate failed"]
        )
    }

    var formatDesc: CMFormatDescription?
    let fdStatus = CMVideoFormatDescriptionCreateForImageBuffer(
        allocator: kCFAllocatorDefault,
        imageBuffer: pb,
        formatDescriptionOut: &formatDesc
    )
    guard fdStatus == noErr, let fd = formatDesc else {
        throw NSError(
            domain: "SessionScreenShareE2ETests",
            code: Int(fdStatus),
            userInfo: [NSLocalizedDescriptionKey: "CMVideoFormatDescriptionCreateForImageBuffer failed"]
        )
    }

    var timing = CMSampleTimingInfo(
        duration: CMTime(value: 1, timescale: 30),
        presentationTimeStamp: CMTime(
            value: Int64(Date().timeIntervalSince1970 * 1_000_000),
            timescale: 1_000_000
        ),
        decodeTimeStamp: .invalid
    )

    var sample: CMSampleBuffer?
    let sbStatus = CMSampleBufferCreateForImageBuffer(
        allocator: kCFAllocatorDefault,
        imageBuffer: pb,
        dataReady: true,
        makeDataReadyCallback: nil,
        refcon: nil,
        formatDescription: fd,
        sampleTiming: &timing,
        sampleBufferOut: &sample
    )
    guard sbStatus == noErr, let sb = sample else {
        throw NSError(
            domain: "SessionScreenShareE2ETests",
            code: Int(sbStatus),
            userInfo: [NSLocalizedDescriptionKey: "CMSampleBufferCreateForImageBuffer failed"]
        )
    }
    return sb
}
