import Foundation
import LiveKit
import Testing
@testable import CosmoRealtime

/// The background client-tool path over a real ``livekit-server`` in dev mode:
/// an agent peer invokes the tool by RPC, and the reply must come back while
/// the handler is still working. The offline suite pins the envelope shapes;
/// only a real SFU round trip shows that the reply is actually released early
/// rather than merely constructed early.
///
/// Skipped unless ``LIVEKIT_TESTING_URL`` is set.
// Serialized for the same reason as the screen-share suite: simultaneous
// connects to the shared dev server intermittently time out.
@Suite("Background client tool E2E", .enabled(if: E2EFixture.isConfigured), .serialized)
struct BackgroundClientToolE2ETests {

    /// Blocks a handler until the test releases it.
    private actor Gate {
        private var released = false
        private var waiters: [CheckedContinuation<Void, Never>] = []
        func release() {
            released = true
            for waiter in waiters { waiter.resume() }
            waiters.removeAll()
        }
        func wait() async {
            if released { return }
            await withCheckedContinuation { waiters.append($0) }
        }
    }

    private actor Capture {
        private(set) var results: [BackgroundToolResult] = []
        func add(_ result: BackgroundToolResult) { results.append(result) }
    }

    private func decode(_ envelope: String) -> [String: JSONValue] {
        guard case .object(let fields)? = try? JSONDecoder().decode(
            JSONValue.self, from: Data(envelope.utf8)
        ) else {
            Issue.record("reply envelope was not a JSON object: \(envelope)")
            return [:]
        }
        return fields
    }

    private func connect(
        _ fixture: E2EFixture, room: Room, identity: String, roomName: String, isAgent: Bool
    ) async throws {
        let token = try TokenGenerator(
            apiKey: fixture.apiKey,
            apiSecret: fixture.apiSecret,
            identity: identity,
            room: roomName,
            isAgent: isAgent
        ).sign()
        try await room.connect(url: fixture.serverURL, token: token)
    }

    @Test("the agent's RPC returns a deferred reply before the handler finishes")
    func deferredReplyBeatsTheHandler() async throws {
        let fixture = try E2EFixture.requireE2EServer()
        let roomName = "e2e-bg-tool-\(UUID().uuidString.prefix(8))"

        let clientRoom = Room()
        let agentRoom = Room()
        let gate = Gate()
        let capture = Capture()
        let sink = ClientToolJobSink(
            deliver: { await capture.add($0) },
            isOpen: { true }
        )

        // Bind before joining, as the transport does: an invocation landing in
        // the join window must be handled, not answered "method not found".
        try await registerBackgroundClientToolHandlers(
            on: clientRoom,
            handlers: [
                "slow_export": { _, job in
                    await job.ack("starting the export")
                    await gate.wait()
                    try await job.complete(
                        result: ["url": .string("https://example.com/q3.pdf")],
                        summary: "the report is ready"
                    )
                }
            ],
            sink: sink,
            hooks: nil,
            sessionId: { "e2e-session" }
        )

        try await connect(fixture, room: clientRoom, identity: "client", roomName: roomName, isAgent: false)
        try await connect(fixture, room: agentRoom, identity: "agent", roomName: roomName, isAgent: true)
        defer {
            Task {
                await clientRoom.disconnect()
                await agentRoom.disconnect()
            }
        }

        // The caller guard reads the client's view of remote participants, so
        // wait for the agent to appear there before invoking.
        try await waitFor("the agent to join the client's room") {
            clientRoom.remoteParticipants.values.contains { $0.kind == .agent }
        }

        let started = Date()
        let envelope = try await agentRoom.localParticipant.performRpc(
            destinationIdentity: Participant.Identity(from: "client"),
            method: "slow_export",
            payload: "{}",
            responseTimeout: 10
        )
        let elapsed = Date().timeIntervalSince(started)

        // The handler is still parked on the gate. Nothing but an early release
        // can produce a reply here.
        let reply = decode(envelope)
        #expect(reply["ok"] == .bool(true))
        #expect(reply["deferred"] == .bool(true))
        #expect(reply["result"] == .object(["note": .string("starting the export")]))
        guard case .string(let jobId)? = reply["job_id"] else {
            Issue.record("deferred reply carried no job_id")
            return
        }
        #expect(!jobId.isEmpty)
        #expect(elapsed < 5, "the reply waited on the handler (elapsed \(elapsed)s)")
        #expect(await capture.results.isEmpty, "no terminal result may land before the work finishes")

        // Let the work finish; the terminal result rides the data channel.
        await gate.release()
        try await waitFor("the terminal result to be published") {
            await !capture.results.isEmpty
        }
        let terminal = await capture.results.first
        #expect(terminal?.jobId == jobId)
        #expect(terminal?.toolName == "slow_export")
        #expect(terminal?.status == .completed)
        #expect(terminal?.summary == "the report is ready")
    }

    @Test("a non-agent caller is rejected before the handler runs")
    func nonAgentCallerIsRejected() async throws {
        let fixture = try E2EFixture.requireE2EServer()
        let roomName = "e2e-bg-tool-guard-\(UUID().uuidString.prefix(8))"

        let clientRoom = Room()
        let peerRoom = Room()
        let ran = Capture()
        let sink = ClientToolJobSink(deliver: { await ran.add($0) }, isOpen: { true })

        try await registerBackgroundClientToolHandlers(
            on: clientRoom,
            handlers: [
                "slow_export": { _, job in
                    await job.ack("should not happen")
                    try await job.complete(result: [:], summary: "should not happen")
                }
            ],
            sink: sink,
            hooks: nil,
            sessionId: { "e2e-session" }
        )

        try await connect(fixture, room: clientRoom, identity: "client", roomName: roomName, isAgent: false)
        try await connect(fixture, room: peerRoom, identity: "peer", roomName: roomName, isAgent: false)
        defer {
            Task {
                await clientRoom.disconnect()
                await peerRoom.disconnect()
            }
        }

        try await waitFor("the peer to join the client's room") {
            !clientRoom.remoteParticipants.isEmpty
        }

        await #expect(throws: (any Error).self) {
            _ = try await peerRoom.localParticipant.performRpc(
                destinationIdentity: Participant.Identity(from: "client"),
                method: "slow_export",
                payload: "{}",
                responseTimeout: 10
            )
        }
        #expect(await ran.results.isEmpty, "a rejected call must not reach the handler")
    }

    /// Poll ``condition`` until it holds, or fail with ``what`` after 10s.
    private func waitFor(
        _ what: String,
        _ condition: @Sendable () async -> Bool
    ) async throws {
        for _ in 0..<100 {
            if await condition() { return }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        Issue.record("timed out waiting for \(what)")
    }
}
