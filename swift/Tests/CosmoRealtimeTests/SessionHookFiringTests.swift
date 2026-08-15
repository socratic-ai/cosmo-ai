import Foundation
import Testing
@testable import CosmoRealtime

/// Verifies that ``RealtimeSession`` fires SessionStart, SessionEnd hooks at
/// the correct lifecycle seams, using ``FakeSessionTransport`` to avoid
/// needing a live LiveKit room.
@Suite("Session hook firing")
struct SessionHookFiringTests {

    // MARK: – Helpers

    private func decodeSentConfigFrame(_ data: Data) -> [String: JSONValue] {
        guard case .object(let fields)? = try? JSONDecoder().decode(JSONValue.self, from: data) else {
            Issue.record("configFrame did not decode as a JSON object")
            return [:]
        }
        return fields
    }

    private func agentInstructions(from data: Data) -> String? {
        let fields = decodeSentConfigFrame(data)
        guard case .object(let agent)? = fields["agent"],
              case .string(let instructions)? = agent["instructions"]
        else { return nil }
        return instructions
    }

    // MARK: – SessionStart fold

    @Test("SessionStart hook extra context is appended to instructions in wire frame")
    func sessionStartFoldAppendsExtra() async throws {
        var hooks: [Hook] = []
        hooks.append(sessionStart { _ in SessionStartResult(additionalContext: "EXTRA") })

        let transport = FakeSessionTransport()
        let session = RealtimeSession(transport: transport)
        try await session._start(config: SessionConfig(instructions: "BASE", hooks: hooks))

        let sentFrames = await transport.sent
        guard let frame = sentFrames.first else {
            Issue.record("no configFrame sent")
            return
        }
        let instructions = agentInstructions(from: frame)
        #expect(instructions == "BASE\n\nEXTRA")
    }

    @Test("SessionStart fold with no prior instructions uses extra as the full instructions")
    func sessionStartFoldNilBase() async throws {
        var hooks: [Hook] = []
        hooks.append(sessionStart { _ in SessionStartResult(additionalContext: "INJECTED") })

        let transport = FakeSessionTransport()
        let session = RealtimeSession(transport: transport)
        try await session._start(config: SessionConfig(hooks: hooks))

        let frame = await transport.sent.first
        let instructions = frame.flatMap { agentInstructions(from: $0) }
        #expect(instructions == "INJECTED")
    }

    @Test("SessionStart hook returning nil does not set instructions when base is nil")
    func sessionStartNilReturnNoInstructions() async throws {
        var hooks: [Hook] = []
        hooks.append(sessionStart { _ in nil })

        let transport = FakeSessionTransport()
        let session = RealtimeSession(transport: transport)
        try await session._start(config: SessionConfig(hooks: hooks))

        let frame = await transport.sent.first
        // instructions key should be absent from the agent sub-object
        let instructions = frame.flatMap { agentInstructions(from: $0) }
        #expect(instructions == nil)
    }

    @Test("SessionStart context is not injected into a catalog agent — the stored config runs verbatim")
    func sessionStartCatalogAgentDropsContext() async throws {
        var hooks: [Hook] = []
        hooks.append(sessionStart { _ in SessionStartResult(additionalContext: "Caller is a VIP.") })

        let transport = FakeSessionTransport()
        let session = RealtimeSession(transport: transport)
        try await session._start(config: SessionConfig(agentName: "driver-pay", hooks: hooks))

        guard let frame = await transport.sent.first else {
            Issue.record("no configFrame sent")
            return
        }
        let fields = decodeSentConfigFrame(frame)
        guard case .object(let agent)? = fields["agent"] else {
            Issue.record("agent sub-object missing from configFrame")
            return
        }
        #expect(agent["type"] == .string("catalog"))
        #expect(agent["name"] == .string("driver-pay"))
        #expect(agent["instructions"] == nil)
    }

    // MARK: – SessionEnd on graceful end

    @Test("SessionEnd hook fires exactly once on graceful end")
    func sessionEndFiresOnEnd() async throws {
        let ctxBox = CaptureBox<SessionEndContext>()
        let fireCount = Counter()
        var hooks: [Hook] = []
        hooks.append(sessionEnd { ctx in
            await fireCount.increment()
            await ctxBox.set(ctx)
        })

        let transport = FakeSessionTransport()
        let session = RealtimeSession(transport: transport)
        try await session._start(config: SessionConfig(hooks: hooks))
        await session.end()

        let count = await fireCount.value
        #expect(count == 1)
        let ctx = await ctxBox.value
        #expect(ctx?.event == "SessionEnd")
        #expect(ctx?.reason == .clientEnded)
        #expect(ctx?.detail == nil)
    }

    @Test("SessionEnd hook fires only once when end() is called twice")
    func sessionEndFiresOnceOnDoubleEnd() async throws {
        let fireCount = Counter()
        var hooks: [Hook] = []
        hooks.append(sessionEnd { _ in await fireCount.increment() })

        let transport = FakeSessionTransport()
        let session = RealtimeSession(transport: transport)
        try await session._start(config: SessionConfig(hooks: hooks))
        await session.end()
        await session.end()

        let count = await fireCount.value
        #expect(count == 1)
    }

    // MARK: – SessionEnd on handshake failure

    @Test("SessionEnd hook fires on handshake failure with sessionId == nil")
    func sessionEndFiresOnHandshakeFailureWithNilSessionId() async throws {
        let sessionIdBox = CaptureBox<String?>()
        let fireCount = Counter()
        var hooks: [Hook] = []
        hooks.append(sessionEnd { ctx in
            await fireCount.increment()
            await sessionIdBox.set(ctx.sessionId)
        })

        let transport = FakeSessionTransport()
        await transport.scriptRejection(.rejected(status: 503, code: nil, detail: "voice off"))
        let session = RealtimeSession(transport: transport)
        _ = try? await session._start(config: SessionConfig(hooks: hooks))

        let count = await fireCount.value
        #expect(count == 1)
        // The session never connected, so sessionId is nil.
        let sid = await sessionIdBox.value
        #expect(sid == .some(nil))
    }

    // MARK: – SessionEnd reason fidelity

    @Test("close() fires SessionEnd with client_closed and sends no end frame")
    func closeFiresClientClosedWithoutEndFrame() async throws {
        let ctxBox = CaptureBox<SessionEndContext>()
        var hooks: [Hook] = []
        hooks.append(sessionEnd { ctx in await ctxBox.set(ctx) })

        let transport = FakeSessionTransport()
        let session = RealtimeSession(transport: transport)
        try await session._start(config: SessionConfig(hooks: hooks))
        await session.close()

        let ctx = await ctxBox.value
        #expect(ctx?.reason == .clientClosed)
        #expect(ctx?.detail == nil)
        // No wire ``end`` frame went out (unlike ``end()``).
        let sentTypes = await transport.sent.map { decodeSentConfigFrame($0)["type"] }
        #expect(!sentTypes.contains(.string("end")))
    }

    @Test("a deliberate server close maps to server_ended with the reason as detail")
    func mappedServerCloseFiresServerEnded() async throws {
        let ctxBox = CaptureBox<SessionEndContext>()
        var hooks: [Hook] = []
        hooks.append(sessionEnd { ctx in await ctxBox.set(ctx) })

        let transport = FakeSessionTransport()
        let session = RealtimeSession(transport: transport)
        try await session._start(config: SessionConfig(hooks: hooks))
        await transport.simulateClose(.serverEnded(reason: "ROOM_DELETED"))

        let ctx = await ctxBox.value
        #expect(ctx?.reason == .serverEnded)
        #expect(ctx?.detail == "ROOM_DELETED")
    }

    @Test("a latched server session-ended reason wins over the transport close")
    func latchedServerReasonWinsOverClose() async throws {
        let ctxBox = CaptureBox<SessionEndContext>()
        var hooks: [Hook] = []
        hooks.append(sessionEnd { ctx in await ctxBox.set(ctx) })

        let transport = FakeSessionTransport()
        let session = RealtimeSession(transport: transport)
        try await session._start(config: SessionConfig(hooks: hooks))
        let frame = Data(#"{"type":"session-ended","reason":"max_session_duration"}"#.utf8)
        await session._receiveFrame(frame)
        await transport.simulateClose(.transportError(message: "room dropped"))

        let ctx = await ctxBox.value
        #expect(ctx?.reason == .serverEnded)
        #expect(ctx?.detail == "max_session_duration")
    }

    @Test("session-ended with no transport close finishes after the grace timer")
    func serverEndGraceForcesTeardown() async throws {
        let ctxBox = CaptureBox<SessionEndContext>()
        var hooks: [Hook] = []
        hooks.append(sessionEnd { ctx in await ctxBox.set(ctx) })

        let transport = FakeSessionTransport()
        let session = RealtimeSession(transport: transport, serverEndGraceNanos: 20_000_000)
        try await session._start(config: SessionConfig(hooks: hooks))
        let frame = Data(#"{"type":"session-ended","reason":"worker done"}"#.utf8)
        await session._receiveFrame(frame)
        // No close follows — the grace timer must force the clean teardown.
        // Polled rather than slept: co-scheduled with the rest of the suite the
        // 20ms timer, the teardown and the hook can take orders of magnitude
        // longer than the timer to drain, so any fixed budget is a race. The
        // ceiling is never reached when the teardown works — the loop exits on
        // the hook — so it costs nothing except when this is actually broken.
        let deadline = ContinuousClock().now + .seconds(30)
        while await ctxBox.value == nil, ContinuousClock().now < deadline {
            try await Task.sleep(for: .milliseconds(5))
        }

        let ctx = await ctxBox.value
        #expect(ctx?.reason == .serverEnded)
        #expect(ctx?.detail == "worker done")
    }
}
