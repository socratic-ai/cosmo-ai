import Foundation
import Testing
@testable import CosmoRealtime

/// Holds the fake MCP transport so a test can assert it was closed.
final class TransportBox: @unchecked Sendable { var t: FakeMCPTransport? }

@Suite("Agent + MCP")
struct AgentTests {
    private func fakeRealtime(_ cfg: SessionConfig) async throws -> RealtimeSession {
        let s = RealtimeSession(transport: FakeSessionTransport())
        try await s._start(config: cfg)
        return s
    }

    @Test func mergesMcpToolsIntoConfig() async throws {
        let caller = AgentTool.client(
            name: "caller", description: "d", parameters: ["type": .string("object")], handler: { _ in [:] }
        )
        let agent = try RealtimeAgent(mcp: McpRegistry(servers: [McpStdioServer(name: "fs", command: "x")]))
        let mcpFactory: MCPTransportFactory = { _ in
            FakeMCPTransport(responses: ["tools/list": #"{"tools":[{"name":"read","inputSchema":{"type":"object"}}]}"#])
        }
        var capturedNames: [String] = []
        let session = try await agent.start(
            config: SessionConfig(tools: [caller]), transportFactory: mcpFactory
        ) { cfg in
            capturedNames = (cfg.tools ?? []).compactMap { if case let .client(n, _, _, _) = $0 { return n }; return nil }
            return try await self.fakeRealtime(cfg)
        }
        #expect(capturedNames == ["caller", "mcp__fs__read"])
        await session.end()
    }

    @Test func endTearsDownMcp() async throws {
        let box = TransportBox()
        let mcpFactory: MCPTransportFactory = { _ in
            let t = FakeMCPTransport(responses: ["tools/list": #"{"tools":[]}"#]); box.t = t; return t
        }
        let agent = try RealtimeAgent(mcp: McpRegistry(servers: [McpStdioServer(name: "fs", command: "x")]))
        let session = try await agent.start(config: SessionConfig(), transportFactory: mcpFactory) { cfg in
            try await self.fakeRealtime(cfg)
        }
        await session.end()
        #expect(box.t?.closed == true)
    }

    @Test func sessionThatClosedDuringStartStillTearsDownMcp() async throws {
        let box = TransportBox()
        let mcpFactory: MCPTransportFactory = { _ in
            let t = FakeMCPTransport(responses: ["tools/list": #"{"tools":[]}"#]); box.t = t; return t
        }
        let agent = try RealtimeAgent(mcp: McpRegistry(servers: [McpStdioServer(name: "fs", command: "x")]))
        _ = try await agent.start(config: SessionConfig(), transportFactory: mcpFactory) { cfg in
            let s = try await self.fakeRealtime(cfg)
            await s.end()
            return s
        }
        #expect(box.t?.closed == true)
    }

    @Test func noMcpPreservesNilTools() async throws {
        let agent = try RealtimeAgent(mcp: nil)
        var captured: [AgentTool]? = []
        _ = try await agent.start(config: SessionConfig(), transportFactory: { _ in FakeMCPTransport() }) { cfg in
            captured = cfg.tools
            return try await self.fakeRealtime(cfg)
        }
        #expect(captured == nil)  // nil config.tools + nothing added ⇒ stays nil (inherits defaults)
    }

    @Test func configHooksReachTheSession() async throws {
        var hooks: [Hook] = []
        hooks.append(sessionStart { _ in SessionStartResult(additionalContext: "Z") })
        let agent = try RealtimeAgent()
        let capturedBox = CaptureBox<SessionConfig>()
        let session = try await agent.start(
            config: SessionConfig(hooks: hooks),
            transportFactory: { _ in FakeMCPTransport() }
        ) { cfg in
            await capturedBox.set(cfg)
            return try await self.fakeRealtime(cfg)
        }
        await session.end()
        let capturedCfg = await capturedBox.value
        #expect(capturedCfg?.hooks != nil)
        let ctx = await capturedCfg?.hookEngine?.runSessionStart()
        #expect(ctx == "Z")
    }

    @Test func hookListOrderIsFoldOrder() async throws {
        // The agent's hooks reach the seam as one unified list on the config,
        // which hands it through untouched — so list order is fold order.
        var hooks: [Hook] = []
        hooks.append(sessionStart { _ in SessionStartResult(additionalContext: "first") })
        hooks.append(sessionStart { _ in SessionStartResult(additionalContext: "second") })
        let agent = try RealtimeAgent()
        let capturedBox = CaptureBox<SessionConfig>()
        let session = try await agent.start(
            config: SessionConfig(hooks: hooks),
            transportFactory: { _ in FakeMCPTransport() }
        ) { cfg in
            await capturedBox.set(cfg)
            return try await self.fakeRealtime(cfg)
        }
        await session.end()
        let ctx = await capturedBox.value?.hookEngine?.runSessionStart()
        #expect(ctx == "first\n\nsecond")
    }

    private func stubClient() -> RealtimeClient {
        makeStubClient(
            StubTransport { jsonResponse(.ok, "{}") },
            options: .init(apiKey: "k", baseURL: URL(string: "https://api.example.com")!)
        )
    }

    private var callerTool: AgentTool {
        .client(name: "caller", description: "d", parameters: ["type": .string("object")])
    }

    @Test func assemblesInlineAgentFieldsAndRunParams() async throws {
        var hooks: [Hook] = []
        hooks.append(sessionStart { _ in SessionStartResult(additionalContext: "a") })
        hooks.append(sessionStart { _ in SessionStartResult(additionalContext: "b") })
        let agent = try stubClient().agent(
            instructions: "You are terse.",
            model: "gemini-live",
            modelOptions: .gemini(temperature: 0.5),
            voice: VoiceConfig(name: "aoede"),
            audio: AudioConfig(output: false),
            tools: [callerTool],
            interruptionSensitivity: .low,
            greeting: "Hi.",
            hooks: hooks
        )

        let config = agent._sessionConfig(
            resumeSessionId: "sess-42",
            maxSessionSeconds: 600,
            storeRecording: true,
            storeAudio: false,
            storeTranscript: true,
            storeVideo: false
        )

        #expect(config.agentName == nil)  // inline: no catalog handle
        #expect(config.agentInputs == nil)
        #expect(config.instructions == "You are terse.")
        #expect(config.model == "gemini-live")
        #expect(config.modelOptions == .gemini(temperature: 0.5))
        #expect(config.voice == VoiceConfig(name: "aoede"))
        #expect(config.audio == AudioConfig(output: false))
        #expect(config.tools == [callerTool])
        #expect(config.interruptionSensitivity == .low)
        #expect(config.greeting == "Hi.")
        // Hooks ride along as one list in the order given, which is the fold
        // order the session runs — they are excluded from SessionConfig
        // equality, so the engine is what can observe them.
        let ctx = await config.hookEngine?.runSessionStart()
        #expect(ctx == "a\n\nb")

        #expect(config.resumeSessionId == "sess-42")
        #expect(config.maxSessionSeconds == 600)
        #expect(config.storeRecording == true)
        #expect(config.storeAudio == false)
        #expect(config.storeTranscript == true)
        #expect(config.storeVideo == false)
    }

    @Test func assemblesCatalogAgentFieldsAndRunParams() {
        let agent = stubClient().catalogAgent(
            "driver-pay", inputs: ["region": "west"], voice: VoiceConfig(name: "puck"),
            tools: [callerTool]
        )

        let config = agent._sessionConfig(resumeSessionId: "sess-7", maxSessionSeconds: 120)

        #expect(config.agentName == "driver-pay")
        #expect(config.agentInputs == ["region": "west"])
        #expect(config.voice == VoiceConfig(name: "puck"))
        #expect(config.tools == [callerTool])
        #expect(config.resumeSessionId == "sess-7")
        #expect(config.maxSessionSeconds == 120)
        // A catalog agent runs its stored config verbatim: only the ride-alongs
        // above may accompany the handle, and the wire payload rejects the rest
        // — so they must assemble unset rather than defaulted.
        #expect(config.instructions == nil)
        #expect(config.model == nil)
        #expect(config.modelOptions == nil)
        #expect(config.audio == nil)
        #expect(config.interruptionSensitivity == nil)
        #expect(config.greeting == nil)
    }

    @Test func emptyToolSetAssemblesAsUnsetAndRunParamsDefaultToNil() throws {
        // An agent declaring no tools must leave ``tools`` unset rather than an
        // explicit empty array: the seam only rewrites ``cfg.tools`` when it has
        // something to add or the field was already set, so an empty array here
        // would put an empty tool list on the wire instead of inheriting the
        // server's default set.
        let agent = try stubClient().agent()

        let config = agent._sessionConfig()

        #expect(config.tools == nil)
        #expect(config.resumeSessionId == nil)
        #expect(config.maxSessionSeconds == nil)
        #expect(config.storeRecording == nil)
        #expect(config.storeAudio == nil)
        #expect(config.storeTranscript == nil)
        #expect(config.storeVideo == nil)
    }

    @Test func agentToolsReachTheAssembledConfig() async throws {
        // The public start assembles the agent's own fields into the config
        // before the seam sees it. The reserved-name guard runs while encoding
        // that assembled config into the start payload — so a tool declared on
        // the agent, never on a config the caller built, is what trips it, and
        // it trips before any network call.
        let agent = try stubClient().agent(
            tools: [
                .client(
                    name: AgentTool.sdkToolNamePrefix + "load_skill",
                    description: "caller's own",
                    parameters: ["type": .string("object")]
                )
            ]
        )
        await #expect {
            _ = try await agent.start()
        } throws: { error in
            guard let error = error as? RealtimeSessionError else { return false }
            return (error.errorDescription ?? "").contains("reserved")
        }
    }
}
