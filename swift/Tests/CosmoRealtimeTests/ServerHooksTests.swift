import Foundation
import Testing
@testable import CosmoRealtime

/// Server-hook config (``SessionConfig/hooks``) and the fired-timeout
/// event — the Swift halves of the cross-SDK contract the Python/TS
/// suites already pin.
@Suite struct ServerHooksTests {

    private static func nudge(_ seconds: Double = 10) -> SilenceTimeout {
        SilenceTimeout(
            action: .say(Say(text: "Are you still there?", _type: .say)),
            maxCount: 2,
            timeoutSeconds: seconds,
            trigger: .user_speech_timeout
        )
    }

    // MARK: – Config surface

    @Test("runtimeHooks serializes into the inline agent wire payload")
    func runtimeHooksOnTheWire() throws {
        let config = SessionConfig(instructions: "hi", hooks: [.server(Self.nudge())])
        let payload = try config.wirePayload()
        guard case .inline(let inline)? = payload.agent else {
            Issue.record("expected an inline agent block")
            return
        }
        #expect(inline.hooks?.count == 1)
        #expect(inline.hooks?.first == Self.nudge())
    }

    @Test("a catalog launch rejects runtimeHooks loudly")
    func catalogRejectsRuntimeHooks() {
        let config = SessionConfig(agentName: "driver-pay", hooks: [.server(Self.nudge())])
        #expect(throws: RealtimeSessionError.self) {
            _ = try config.wirePayload()
        }
    }

    @Test("runtimeHooks participates in equality, unlike local hooks")
    func equalityIncludesRuntimeHooks() {
        let a = SessionConfig(instructions: "hi", hooks: [.server(Self.nudge())])
        let b = SessionConfig(instructions: "hi", hooks: nil)
        #expect(a != b)
        #expect(a == SessionConfig(instructions: "hi", hooks: [.server(Self.nudge())]))
    }

    // MARK: – Observe seam

    private static let timeoutFrame = Data("""
        {"type":"user-speech-timeout","session_id":"sess-1","silence_ms":10000,\
        "trigger_count":1,"max_count":2,"action":{"type":"say","text":"Are you still there?"}}
        """.utf8)

    @Test("a fired server hook surfaces as an event, not a hook seam")
    func firedTimeoutSurfacesAsEvent() async throws {
        let transport = FakeSessionTransport()
        let session = RealtimeSession(transport: transport)
        try await session._start(config: SessionConfig(hooks: [Hook.server(Self.nudge())]))

        let consumer = Task { () -> RealtimeSession.UserSpeechTimeout? in
            for try await event in session.events {
                if case .userSpeechTimeout(let payload) = event { return payload }
            }
            return nil
        }
        await session._receiveFrame(Self.timeoutFrame)
        let payload = try await consumer.value
        await session.end()

        let timeout = try #require(payload)
        #expect(timeout.sessionId == "sess-1")
        #expect(timeout.silenceMs == 10000)
        #expect(timeout.triggerCount == 1)
        #expect(timeout.maxCount == 2)
        if case .say(let say) = timeout.action {
            #expect(say.text == "Are you still there?")
        } else {
            Issue.record("expected a say action")
        }
    }
}
