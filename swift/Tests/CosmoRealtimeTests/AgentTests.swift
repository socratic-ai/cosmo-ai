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
        let caller = SessionConfig.Tool.client(
            name: "caller", description: "d", parameters: ["type": .string("object")], handler: { _ in [:] }
        )
        let agent = try RealtimeAgent(tools: [caller], mcp: McpRegistry(servers: [McpStdioServer(name: "fs", command: "x")]))
        let mcpFactory: MCPTransportFactory = { _ in
            FakeMCPTransport(responses: ["tools/list": #"{"tools":[{"name":"read","inputSchema":{"type":"object"}}]}"#])
        }
        var capturedNames: [String] = []
        let session = try await agent.start(config: SessionConfig(), transportFactory: mcpFactory) { cfg in
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
        let agent = try RealtimeAgent(tools: [], mcp: nil)
        var captured: [SessionConfig.Tool]? = []
        _ = try await agent.start(config: SessionConfig(), transportFactory: { _ in FakeMCPTransport() }) { cfg in
            captured = cfg.tools
            return try await self.fakeRealtime(cfg)
        }
        #expect(captured == nil)  // nil config.tools + nothing added ⇒ stays nil (inherits defaults)
    }

    @Test func agentForwardsHooksToConfig() async throws {
        var hooks: [Hook] = []
        hooks.append(sessionStart { _ in SessionStartResult(additionalContext: "Z") })
        let agent = try RealtimeAgent(hooks: hooks)
        let capturedBox = CaptureBox<SessionConfig>()
        let session = try await agent.start(
            config: SessionConfig(),
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

    @Test func agentHooksAppendAfterConfigHooks() async throws {
        var configHooks: [Hook] = []
        configHooks.append(sessionStart { _ in SessionStartResult(additionalContext: "config") })
        var agentHooks: [Hook] = []
        agentHooks.append(sessionStart { _ in SessionStartResult(additionalContext: "agent") })
        let agent = try RealtimeAgent(hooks: agentHooks)
        let capturedBox = CaptureBox<SessionConfig>()
        let session = try await agent.start(
            config: SessionConfig(hooks: configHooks),
            transportFactory: { _ in FakeMCPTransport() }
        ) { cfg in
            await capturedBox.set(cfg)
            return try await self.fakeRealtime(cfg)
        }
        await session.end()
        // One unified list: config hooks first, then the agent's — the same
        // order the tool merge uses (inherited → agent additions).
        let ctx = await capturedBox.value?.hookEngine?.runSessionStart()
        #expect(ctx == "config\n\nagent")
    }
}
