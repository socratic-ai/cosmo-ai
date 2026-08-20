import Foundation

/// A configured agent, created by ``RealtimeClient/agent(instructions:model:modelOptions:voice:audio:tools:interruptionSensitivity:greeting:skills:mcp:hooks:)``
/// or ``RealtimeClient/catalogAgent(_:inputs:voice:tools:mcp:hooks:)``: the
/// persona — what the agent is, independent of any one run. Reused
/// unchanged across sessions;
/// ``start(resumeSessionId:maxSessionSeconds:storeRecording:storeAudio:storeTranscript:storeVideo:micMuted:rpcHandlers:)``
/// opens one run with its per-run params.
public struct RealtimeAgent: Sendable {
    /// The creating client — credentials, endpoints, timeouts. ``nil`` only
    /// for module-internal test construction; the factories always set it.
    let client: RealtimeClient?

    /// Machine handle of the workspace catalog agent this references;
    /// ``nil`` for an inline agent.
    public let name: String?
    /// String inputs for a catalog agent's template placeholders.
    public let inputs: [String: String]?
    /// System instructions. Replaces the server's neutral default when set.
    public let instructions: String?
    /// Provider/model selection. ``nil`` lets the server choose its default.
    public let model: String?
    /// Provider-scoped model knobs, discriminated on provider.
    public let modelOptions: ModelOptions?
    /// How the agent sounds — prebuilt voice id and speaking style.
    public let voice: VoiceConfig?
    /// The agent's audio pipeline — output emission, inbound noise
    /// cancellation, and the ambience bed.
    public let audio: AudioConfig?
    /// Tool set for the agent's sessions: client-executed specs plus opt-in
    /// server tools.
    public let tools: [AgentTool]
    /// How readily the user's speech interrupts the agent.
    public let interruptionSensitivity: InterruptionSensitivity?
    /// Opening line the assistant speaks as soon as the model session opens.
    public let greeting: String?
    /// Skills folded into the persona: the menu rides resident in the
    /// instructions and the load tool joins the tool set at start.
    public let skills: [Skill]
    /// MCP servers whose tools join the set at start; the session owns the
    /// connections from there on.
    public let mcp: McpRegistry?
    /// Client hooks (in-process seam callbacks) and declarative server hooks.
    public let hooks: [Hook]?

    init(
        client: RealtimeClient?,
        name: String? = nil,
        inputs: [String: String]? = nil,
        instructions: String? = nil,
        model: String? = nil,
        modelOptions: ModelOptions? = nil,
        voice: VoiceConfig? = nil,
        audio: AudioConfig? = nil,
        tools: [AgentTool] = [],
        interruptionSensitivity: InterruptionSensitivity? = nil,
        greeting: String? = nil,
        skills: [Skill] = [],
        mcp: McpRegistry? = nil,
        hooks: [Hook]? = nil
    ) {
        self.client = client
        self.name = name
        self.inputs = inputs
        self.instructions = instructions
        self.model = model
        self.modelOptions = modelOptions
        self.voice = voice
        self.audio = audio
        self.tools = tools
        self.interruptionSensitivity = interruptionSensitivity
        self.greeting = greeting
        self.skills = skills
        self.mcp = mcp
        self.hooks = hooks
    }

    /// Test seam: an agent with no client, driven through
    /// ``start(config:transportFactory:makeSession:)`` over a fake session.
    /// Duplicate skill names throw here — when the agent is built, not
    /// mid-call.
    init(
        tools: [AgentTool] = [],
        skills: [Skill] = [],
        mcp: McpRegistry? = nil,
        hooks: [Hook]? = nil
    ) throws {
        self.init(
            client: nil,
            tools: tools,
            skills: try resolveSkills(skills),
            mcp: mcp,
            hooks: hooks
        )
    }

    /// Open one session from this agent: the agent's config plus this run's
    /// params. The session owns any MCP connections from here on: ending it
    /// tears them down too.
    /// - Parameter micMuted: when `true`, the session joins WITHOUT
    ///   publishing the microphone — nothing is captured or sent until the
    ///   first ``RealtimeSession/setMuted(_:)`` with `false`.
    /// - Parameter rpcHandlers: client-tool handlers registered by method name
    ///   but **not** advertised to the agent — for server-orchestrated tools the
    ///   server invokes over RPC directly (never chosen from the tool list).
    ///   Advertised-and-handled tools belong in ``tools`` as an
    ///   ``AgentTool/client(name:description:parameters:handler:)``; these are
    ///   the register-only complement. On a name collision the ``rpcHandlers``
    ///   entry wins.
    public func start(
        resumeSessionId: String? = nil,
        maxSessionSeconds: Int? = nil,
        storeRecording: Bool? = nil,
        storeAudio: Bool? = nil,
        storeTranscript: Bool? = nil,
        storeVideo: Bool? = nil,
        micMuted: Bool = false,
        rpcHandlers: [String: ClientToolHandler] = [:]
    ) async throws -> RealtimeSession {
        guard let client else {
            preconditionFailure(
                "RealtimeAgent without a client — create agents via RealtimeClient"
            )
        }
        let config = _sessionConfig(
            resumeSessionId: resumeSessionId,
            maxSessionSeconds: maxSessionSeconds,
            storeRecording: storeRecording,
            storeAudio: storeAudio,
            storeTranscript: storeTranscript,
            storeVideo: storeVideo
        )
        return try await start(
            config: config,
            transportFactory: defaultMCPTransportFactory
        ) { cfg in
            try await RealtimeSession.start(
                client.options, config: cfg, micMuted: micMuted, rpcHandlers: rpcHandlers
            )
        }
    }

    /// The agent's fields plus one run's params, assembled into the wire
    /// config ``start(resumeSessionId:maxSessionSeconds:storeRecording:storeAudio:storeTranscript:storeVideo:micMuted:rpcHandlers:)``
    /// sends.
    func _sessionConfig(
        resumeSessionId: String? = nil,
        maxSessionSeconds: Int? = nil,
        storeRecording: Bool? = nil,
        storeAudio: Bool? = nil,
        storeTranscript: Bool? = nil,
        storeVideo: Bool? = nil
    ) -> SessionConfig {
        SessionConfig(
            agentName: name,
            agentInputs: inputs,
            model: model,
            modelOptions: modelOptions,
            voice: voice,
            audio: audio,
            instructions: instructions,
            tools: tools.isEmpty ? nil : tools,
            interruptionSensitivity: interruptionSensitivity,
            greeting: greeting,
            resumeSessionId: resumeSessionId,
            maxSessionSeconds: maxSessionSeconds,
            storeRecording: storeRecording,
            storeAudio: storeAudio,
            storeTranscript: storeTranscript,
            storeVideo: storeVideo,
            hooks: hooks
        )
    }

    /// The skills/MCP fold, seamed on ``makeSession`` so tests can drive it
    /// over a fake transport. ``config`` arrives with the agent's own fields
    /// already assembled.
    func start(
        config: SessionConfig,
        transportFactory: MCPTransportFactory,
        makeSession: @Sendable (SessionConfig) async throws -> RealtimeSession
    ) async throws -> RealtimeSession {
        var cfg = config

        var skillTools: [AgentTool] = []
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

        // Tools already in the assembled config plus our own additions reserve
        // the namespace: a colliding MCP tool is dropped, and a duplicate-named
        // addition never shadows an earlier handler or reaches the wire twice.
        // First occurrence wins, in order: agent tools → cosmo_sdk_load_skill
        // → MCP.
        let assembled = cfg.tools ?? []
        let reserved = Set((assembled + skillTools).map(\.name))
        let connected = try await mcp?.connect(reservedNames: reserved, transportFactory: transportFactory)
        do {
            let mcpTools: [AgentTool]
            if let connected { mcpTools = await connected.tools } else { mcpTools = [] }
            var seen = Set(assembled.map(\.name))
            let added = (skillTools + mcpTools).filter { seen.insert($0.name).inserted }
            if !added.isEmpty || cfg.tools != nil {
                cfg.tools = assembled + added
            }
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
