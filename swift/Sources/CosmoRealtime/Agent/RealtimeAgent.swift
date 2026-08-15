import Foundation

/// Augments a session's tools with skills and MCP servers, augments its
/// instructions with the resident skill menu, and owns the MCP lifecycle.
public struct RealtimeAgent: Sendable {
    public var tools: [SessionConfig.Tool]
    public var skills: [Skill]
    public var mcp: McpRegistry?
    public var hooks: [Hook]?

    /// Duplicate skill names throw here — when the agent is built, not
    /// mid-call.
    public init(
        tools: [SessionConfig.Tool] = [],
        skills: [Skill] = [],
        mcp: McpRegistry? = nil,
        hooks: [Hook]? = nil
    ) throws {
        self.tools = tools
        self.skills = try resolveSkills(skills)
        self.mcp = mcp
        self.hooks = hooks
    }

    /// Open one session from this agent. The session owns any MCP
    /// connections from here on: ending it tears them down too.
    public func start(
        _ options: RealtimeSession.Options,
        config: SessionConfig = SessionConfig(),
        micMuted: Bool = false
    ) async throws -> RealtimeSession {
        try await start(
            config: config,
            transportFactory: defaultMCPTransportFactory
        ) { cfg in
            try await RealtimeSession.start(options, config: cfg, micMuted: micMuted)
        }
    }

    func start(
        config: SessionConfig,
        transportFactory: MCPTransportFactory,
        makeSession: @Sendable (SessionConfig) async throws -> RealtimeSession
    ) async throws -> RealtimeSession {
        var cfg = config

        var skillTools: [SessionConfig.Tool] = []
        if let wiring = buildLoadSkillTool(skills) {
            skillTools = [wiring.tool]
            if !wiring.menu.isEmpty {
                if let existing = cfg.instructions, !existing.isEmpty {
                    cfg.instructions = "\(existing)\n\n\(wiring.menu)"
                } else {
                    cfg.instructions = wiring.menu
                }
            }
        }

        // Tools already in the resolved config (inherited defaults + per-call)
        // plus our own additions reserve the namespace: a colliding MCP tool is
        // dropped, and a duplicate-named addition never shadows an earlier
        // handler or reaches the wire twice. First occurrence wins, in order:
        // inherited → agent tools → cosmo_sdk_load_skill → MCP.
        let inherited = cfg.tools ?? []
        let reserved = Set((inherited + tools + skillTools).map(\.name))
        let connected = try await mcp?.connect(reservedNames: reserved, transportFactory: transportFactory)
        do {
            let mcpTools: [SessionConfig.Tool]
            if let connected { mcpTools = await connected.tools } else { mcpTools = [] }
            var seen = Set(inherited.map(\.name))
            let added = (tools + skillTools + mcpTools).filter { seen.insert($0.name).inserted }
            if !added.isEmpty || cfg.tools != nil {
                cfg.tools = inherited + added
            }
            if let hooks { cfg.hooks = (cfg.hooks ?? []) + hooks }
            let session = try await makeSession(cfg)
            if let connected {
                await session._attachOnClose { await connected.aclose() }
            }
            return session
        } catch {
            if let connected { await connected.aclose() }
            throw error
        }
    }
}
