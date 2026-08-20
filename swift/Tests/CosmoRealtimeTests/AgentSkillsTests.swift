import Foundation
import Testing
@testable import CosmoRealtime

@Suite("Agent + Skills")
struct AgentSkillsTests {
    private func fakeRealtime(_ cfg: SessionConfig) async throws -> RealtimeSession {
        let s = RealtimeSession(transport: FakeSessionTransport())
        try await s._start(config: cfg)
        return s
    }

    private func hotSkill(_ name: String, _ desc: String = "d") -> Skill {
        Skill(name: name, description: desc, body: "BODY \(name)")
    }

    private func toolNames(_ cfg: SessionConfig) -> [String] {
        (cfg.tools ?? []).map(\.name)
    }

    private let refundsMenu =
        "## Skills\nCall cosmo_sdk_load_skill(name) to load private instructions when the conversation reaches the matching path:\n- refunds: handle refunds"

    @Test func injectsLoadSkillToolAndAppendsMenuToInstructions() async throws {
        let agent = try RealtimeAgent(skills: [hotSkill("refunds", "handle refunds")])
        var names: [String] = []
        var instructions: String?
        let s = try await agent.start(
            config: SessionConfig(instructions: "You are terse."),
            transportFactory: { _ in FakeMCPTransport() }
        ) { cfg in
            names = self.toolNames(cfg)
            instructions = cfg.instructions
            return try await self.fakeRealtime(cfg)
        }
        #expect(names == ["cosmo_sdk_load_skill"])
        #expect(instructions == "You are terse.\n\n\(refundsMenu)")
        await s.end()
    }

    @Test func menuBecomesInstructionsWhenNoneSet() async throws {
        let agent = try RealtimeAgent(skills: [hotSkill("refunds", "handle refunds")])
        var instructions: String?
        let s = try await agent.start(config: SessionConfig(), transportFactory: { _ in FakeMCPTransport() }) { cfg in
            instructions = cfg.instructions
            return try await self.fakeRealtime(cfg)
        }
        #expect(instructions == refundsMenu)
        await s.end()
    }

    @Test func emptyInstructionsBecomesMenuAlone() async throws {
        // Empty (not nil) instructions must not produce leading blank lines —
        // mirrors Python treating "" as falsy.
        let agent = try RealtimeAgent(skills: [hotSkill("refunds", "handle refunds")])
        var instructions: String?
        let s = try await agent.start(config: SessionConfig(instructions: ""), transportFactory: { _ in FakeMCPTransport() }) { cfg in
            instructions = cfg.instructions
            return try await self.fakeRealtime(cfg)
        }
        #expect(instructions == refundsMenu)
        await s.end()
    }

    @Test func configPersonaAndToolsPreservedUnderSkills() async throws {
        // A skill must augment — not replace — instructions/tools the caller
        // supplied on the config.
        let defaultTool = AgentTool.client(
            name: "web_search", description: "d", parameters: ["type": .string("object")], handler: { _ in [:] }
        )
        let agent = try RealtimeAgent(skills: [hotSkill("refunds", "handle refunds")])
        var names: [String] = []
        var instructions: String?
        let s = try await agent.start(
            config: SessionConfig(instructions: "You are Cosmo.", tools: [defaultTool]),
            transportFactory: { _ in FakeMCPTransport() }
        ) { cfg in
            names = self.toolNames(cfg)
            instructions = cfg.instructions
            return try await self.fakeRealtime(cfg)
        }
        #expect(instructions == "You are Cosmo.\n\n\(refundsMenu)")
        #expect(names == ["web_search", "cosmo_sdk_load_skill"])
        await s.end()
    }

    @Test func noSkillsAddsNoToolAndLeavesConfigUntouched() async throws {
        let agent = try RealtimeAgent(skills: [])
        var tools: [AgentTool]?
        var instructions: String?
        let s = try await agent.start(
            config: SessionConfig(instructions: "persona"),
            transportFactory: { _ in FakeMCPTransport() }
        ) { cfg in
            tools = cfg.tools
            instructions = cfg.instructions
            return try await self.fakeRealtime(cfg)
        }
        #expect(tools == nil)
        #expect(instructions == "persona")
        await s.end()
    }

    @Test func loadSkillHandlerReturnsBodyInPrivateEnvelope() async throws {
        let agent = try RealtimeAgent(skills: [hotSkill("refunds")])
        var handler: ClientToolHandler?
        let s = try await agent.start(config: SessionConfig(), transportFactory: { _ in FakeMCPTransport() }) { cfg in
            if case let .sdkClient(tool)? = (cfg.tools ?? []).first { handler = tool.handler }
            return try await self.fakeRealtime(cfg)
        }
        let out = try await handler?(["name": .string("refunds")])
        #expect(out?["instructions"] == .string(privateInstructionsPrefix + "BODY refunds"))
        await s.end()
    }

    @Test func skillsCallerToolsAndMcpAllMerge() async throws {
        let caller = AgentTool.client(
            name: "caller", description: "d", parameters: ["type": .string("object")], handler: { _ in [:] }
        )
        let agent = try RealtimeAgent(
            skills: [hotSkill("refunds")],
            mcp: McpRegistry(servers: [McpStdioServer(name: "fs", command: "x")])
        )
        let mcpFactory: MCPTransportFactory = { _ in
            FakeMCPTransport(responses: ["tools/list": #"{"tools":[{"name":"read","inputSchema":{"type":"object"}}]}"#])
        }
        var names: [String] = []
        let session = try await agent.start(
            config: SessionConfig(tools: [caller]), transportFactory: mcpFactory
        ) { cfg in
            names = self.toolNames(cfg)
            return try await self.fakeRealtime(cfg)
        }
        #expect(names == ["caller", "cosmo_sdk_load_skill", "mcp__fs__read"])
        await session.end()
    }

    @Test func reservedNamesDropCollidingMcpTool() async throws {
        // The reserved set (config tools + skill tool names) must flow into
        // mcp.connect: an MCP tool whose exposed name collides is dropped.
        let caller = AgentTool.client(
            name: "mcp__fs__read", description: "d", parameters: ["type": .string("object")], handler: { _ in [:] }
        )
        let agent = try RealtimeAgent(
            skills: [hotSkill("refunds")],
            mcp: McpRegistry(servers: [McpStdioServer(name: "fs", command: "x")])
        )
        let mcpFactory: MCPTransportFactory = { _ in
            FakeMCPTransport(responses: ["tools/list": #"{"tools":[{"name":"read","inputSchema":{"type":"object"}}]}"#])
        }
        var names: [String] = []
        let s = try await agent.start(
            config: SessionConfig(tools: [caller]), transportFactory: mcpFactory
        ) { cfg in
            names = self.toolNames(cfg)
            return try await self.fakeRealtime(cfg)
        }
        #expect(names == ["mcp__fs__read", "cosmo_sdk_load_skill"])  // the MCP read is dropped (name collision)
        await s.end()
    }

    @Test func configToolReservesNameAgainstMcp() async throws {
        // With no skills in play there is no skill tool in the reserved set, so
        // the config's own tool is the only thing reserving the name — and it
        // still drops the colliding MCP tool.
        let defaultTool = AgentTool.client(
            name: "mcp__fs__read", description: "d", parameters: ["type": .string("object")], handler: { _ in [:] }
        )
        let agent = try RealtimeAgent(mcp: McpRegistry(servers: [McpStdioServer(name: "fs", command: "x")]))
        let mcpFactory: MCPTransportFactory = { _ in
            FakeMCPTransport(responses: ["tools/list": #"{"tools":[{"name":"read","inputSchema":{"type":"object"}}]}"#])
        }
        var names: [String] = []
        let s = try await agent.start(
            config: SessionConfig(tools: [defaultTool]),
            transportFactory: mcpFactory
        ) { cfg in
            names = self.toolNames(cfg)
            return try await self.fakeRealtime(cfg)
        }
        #expect(names == ["mcp__fs__read"])  // inherited tool kept; colliding MCP read dropped
        await s.end()
    }

    @Test func callerToolNamedReservedNameIsRejected() async throws {
        // The SDK's load-skill tool now lives in the reserved cosmo_sdk_
        // namespace, so a caller tool taking that name is rejected at session
        // start — it never silently drops the skills.
        let caller = AgentTool.client(
            name: loadSkillToolName, description: "caller's own", parameters: ["type": .string("object")], handler: { _ in [:] }
        )
        let agent = try RealtimeAgent(skills: [hotSkill("refunds")])
        await #expect {
            _ = try await agent.start(
                config: SessionConfig(tools: [caller]), transportFactory: { _ in FakeMCPTransport() }
            ) { cfg in
                try await self.fakeRealtime(cfg)
            }
        } throws: { error in
            guard let error = error as? RealtimeSessionError else { return false }
            return (error.errorDescription ?? "").contains("reserved")
        }
    }

    @Test func callerToolNamedLoadSkillCoexistsWithSkills() async throws {
        // `load_skill` is now an ordinary caller name — the SDK moved its tool
        // into the reserved namespace — so a caller tool taking it is left in
        // place and the skills' own cosmo_sdk_load_skill tool and menu still attach.
        let caller = AgentTool.client(
            name: "load_skill", description: "caller's own", parameters: ["type": .string("object")], handler: { _ in [:] }
        )
        let agent = try RealtimeAgent(skills: [hotSkill("refunds", "handle refunds")])
        var names: [String] = []
        var instructions: String?
        let s = try await agent.start(
            config: SessionConfig(instructions: "You are Alex.", tools: [caller]),
            transportFactory: { _ in FakeMCPTransport() }
        ) { cfg in
            names = self.toolNames(cfg)
            instructions = cfg.instructions
            return try await self.fakeRealtime(cfg)
        }
        #expect(names == ["load_skill", "cosmo_sdk_load_skill"])
        #expect(instructions == "You are Alex.\n\n\(refundsMenu)")
        await s.end()
    }
}
