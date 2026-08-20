import CosmoRealtimeAPI
import Foundation

/// Tier-2 server hook: perform an action after sustained customer
/// silence. Wire config — serialized in the agent block and executed
/// server-side, so it works with no client attached (telephony).
public typealias SilenceTimeout = CosmoRealtimeAPI.Components.Schemas.SilenceTimeout
/// Idle-message action for ``SilenceTimeout``: ``text`` = exact words,
/// ``prompt`` = model-generated, both nil = free model speech.
public typealias Say = CosmoRealtimeAPI.Components.Schemas.Say
/// End-call action for ``SilenceTimeout``.
public typealias EndCall = CosmoRealtimeAPI.Components.Schemas.EndCall

/// How readily the user's speech interrupts the agent.
public typealias InterruptionSensitivity =
    CosmoRealtimeAPI.Components.Schemas.InterruptionSensitivity
/// Reasoning depth for Gemini models.
public typealias ThinkingLevel =
    CosmoRealtimeAPI.Components.Schemas.ThinkingLevel
/// How readily the provider decides the user's turn ended under `serverVad`.
public typealias EndOfSpeechSensitivity =
    CosmoRealtimeAPI.Components.Schemas.EndOfSpeechSensitivity
/// How eagerly OpenAI's semantic detector closes the user's turn.
public typealias SemanticEagerness =
    CosmoRealtimeAPI.Components.Schemas.SemanticEagerness
/// Which turn detector ends the user's turn, on the wire.
public typealias TurnDetectionMode =
    CosmoRealtimeAPI.Components.Schemas.TurnDetectionMode

/// How the agent sounds: the prebuilt voice and the per-run speaking
/// style.
public struct VoiceConfig: Sendable, Equatable {
    /// Provider-specific prebuilt voice id. ``nil`` lets the upstream
    /// pick per session — the voice then drifts between connects.
    public var name: String?
    /// A "how to speak" instruction appended to the system prompt (e.g.
    /// warm / delivery / human, or any caller text). ``nil`` keeps the
    /// server default.
    public var speakingStyle: String?

    public init(name: String? = nil, speakingStyle: String? = nil) {
        self.name = name
        self.speakingStyle = speakingStyle
    }

    /// ``nil`` when nothing is set, so an empty block stays off the wire.
    var wire: CosmoRealtimeAPI.Components.Schemas.VoiceConfig? {
        if name == nil && speakingStyle == nil { return nil }
        return .init(name: name, speakingStyle: speakingStyle)
    }
}

/// Background-ambience bed mixed into the assistant's OUTPUT audio.
/// Presence of the object enables the bed; leave ``AudioConfig/ambience``
/// ``nil`` for none.
public struct AmbienceConfig: Sendable, Equatable {
    /// Named ambience bed to play (e.g. ``"office"``); ``nil`` uses the
    /// default bed.
    public var track: String?
    /// Bed level relative to full scale (dB, -60..0); sits under speech.
    /// ``nil`` keeps the server default.
    public var gainDb: Double?

    public init(track: String? = nil, gainDb: Double? = nil) {
        self.track = track
        self.gainDb = gainDb
    }

    /// Never ``nil`` — presence is what enables the bed, so an empty
    /// object still crosses the wire.
    var wire: CosmoRealtimeAPI.Components.Schemas.AmbienceConfig {
        .init(gainDb: gainDb, track: track.flatMap { .init(rawValue: $0) })
    }
}

/// The agent's audio pipeline, configured once — not per run.
public struct AudioConfig: Sendable, Equatable {
    /// Whether the agent emits audio. ``false`` runs the session
    /// text-only: no speech is produced while input transcription and
    /// text output are unaffected. Rejected at session start when the
    /// resolved model cannot run text-only (self-contained
    /// speech-to-speech providers). ``nil`` keeps the server default
    /// (on).
    public var output: Bool?
    /// Enable upstream noise cancellation on the input audio. ``nil``
    /// keeps the server default (off). Set ``true`` when the microphone
    /// will hear more than one voice.
    public var noiseCancellation: Bool?
    /// Background-ambience bed on the assistant's output; present =
    /// enabled.
    public var ambience: AmbienceConfig?

    public init(
        output: Bool? = nil,
        noiseCancellation: Bool? = nil,
        ambience: AmbienceConfig? = nil
    ) {
        self.output = output
        self.noiseCancellation = noiseCancellation
        self.ambience = ambience
    }

    /// ``nil`` when nothing is set, so an empty block stays off the wire.
    var wire: CosmoRealtimeAPI.Components.Schemas.AudioConfig? {
        if output == nil && noiseCancellation == nil && ambience == nil {
            return nil
        }
        return .init(
            ambience: ambience?.wire,
            noiseCancellation: noiseCancellation,
            output: output
        )
    }
}

/// Provider-scoped model knobs, discriminated on the provider. A knob is
/// honored only by its provider — ``thinkingLevel`` lives only on
/// ``gemini(temperature:maxOutputTokens:thinkingLevel:includeThoughts:endOfSpeechSensitivity:silenceDurationMs:prefixPaddingMs:turnDetection:)``
/// — so an illegal pairing is unrepresentable. ``RealtimeClient/agent(instructions:model:modelOptions:voice:audio:tools:interruptionSensitivity:greeting:skills:mcp:hooks:)``'s
/// `model` selects the concrete model within the chosen provider.
public enum ModelOptions: Sendable, Equatable {
    /// Which turn detector ends the user's turn on Gemini.
    /// ``cosmoVad(pauseMs:prefixMs:maxHoldMs:)`` opts the session into
    /// Cosmo's own semantic detector — a pause triggers one end-of-turn
    /// inference, so a mid-thought pause holds the turn open. ``serverVad``
    /// pins the provider's fixed silence window. ``nil`` keeps the server
    /// default (currently ``serverVad``). Each detector owns its knobs:
    /// ``endOfSpeechSensitivity``, ``silenceDurationMs`` and
    /// ``prefixPaddingMs`` tune ``serverVad`` and the server rejects them
    /// alongside ``cosmoVad(pauseMs:prefixMs:maxHoldMs:)``, whose own knobs
    /// ride the case.
    public enum GeminiTurnDetection: Sendable, Equatable {
        /// Ends the turn after a fixed window of silence.
        case serverVad
        /// Ends the turn as soon as the utterance reads as complete.
        /// ``pauseMs`` is the silence that triggers the inference,
        /// ``prefixMs`` the audio kept from before speech was detected, and
        /// ``maxHoldMs`` the total silence after which the turn ends
        /// regardless of the classifier's verdict. ``nil`` keeps the server
        /// default.
        case cosmoVad(
            pauseMs: Int? = nil,
            prefixMs: Int? = nil,
            maxHoldMs: Int? = nil
        )
    }

    /// Which OpenAI-Realtime turn detector runs, and the knobs it reads. Each
    /// detector carries only its own, so pairing ``semanticVad(eagerness:)``'s
    /// eagerness with the fixed silence window is unrepresentable.
    public enum OpenAITurnDetection: Sendable, Equatable {
        /// Ends the turn after a fixed window of silence.
        case serverVad(
            silenceDurationMs: Int? = nil,
            prefixPaddingMs: Int? = nil
        )
        /// Ends the turn as soon as the utterance reads as complete.
        /// ``eagerness`` paces it — ``high`` answers sooner, ``low`` waits
        /// longer for the user to continue.
        case semanticVad(eagerness: SemanticEagerness? = nil)
    }

    /// Gemini-realtime knobs. ``turnDetection`` selects the end-of-turn
    /// detector: ``GeminiTurnDetection/cosmoVad(pauseMs:prefixMs:maxHoldMs:)``
    /// opts the session into Cosmo's semantic turn detection, which
    /// classifies whether the utterance reads as finished instead of timing
    /// a silence window; ``GeminiTurnDetection/serverVad`` pins the
    /// provider's silence-window detection, which is what
    /// ``endOfSpeechSensitivity``, ``silenceDurationMs`` and
    /// ``prefixPaddingMs`` tune (they are read only under
    /// ``GeminiTurnDetection/serverVad``). ``nil`` keeps the server default
    /// (currently ``GeminiTurnDetection/serverVad``).
    case gemini(
        temperature: Double? = nil,
        maxOutputTokens: Int? = nil,
        thinkingLevel: ThinkingLevel? = nil,
        includeThoughts: Bool? = nil,
        endOfSpeechSensitivity: EndOfSpeechSensitivity? = nil,
        silenceDurationMs: Int? = nil,
        prefixPaddingMs: Int? = nil,
        turnDetection: GeminiTurnDetection? = nil
    )
    /// OpenAI Realtime — pins its own sampling and token limits, so
    /// ``turnDetection`` is the only thing to tune. ``nil`` keeps the
    /// server's default detector.
    case openai(turnDetection: OpenAITurnDetection? = nil)
    /// OpenAI Realtime mini tier — the same API on a faster, cheaper
    /// model, and equally untunable today.
    case openaiMini
    /// xAI Grok Voice — pins its own sampling and token limits, and runs
    /// one detector, a fixed silence window, so its two knobs are the only
    /// thing to tune. ``nil`` keeps the server's default for each.
    case grok(
        silenceDurationMs: Int? = nil,
        prefixPaddingMs: Int? = nil
    )

    /// The provider-scoped wire block: only the selected provider's knobs
    /// cross the wire, with the discriminator set explicitly.
    var wire: CosmoRealtimeAPI.Components.Schemas.InlineAgentConfig
        .ModelOptionsPayload
    {
        switch self {
        case let .gemini(
            temperature,
            maxOutputTokens,
            thinkingLevel,
            includeThoughts,
            endOfSpeechSensitivity,
            silenceDurationMs,
            prefixPaddingMs,
            turnDetection
        ):
            let wireTurnDetection:
                CosmoRealtimeAPI.Components.Schemas.TurnDetectionMode?
            var cosmoVad: CosmoRealtimeAPI.Components.Schemas.CosmoVadConfig?
            switch turnDetection {
            case nil:
                wireTurnDetection = nil
            case .serverVad:
                wireTurnDetection = .serverVad
            case let .cosmoVad(pauseMs, prefixMs, maxHoldMs):
                wireTurnDetection = .cosmoVad
                if pauseMs != nil || prefixMs != nil || maxHoldMs != nil {
                    cosmoVad = .init(
                        maxHoldMs: maxHoldMs,
                        pauseMs: pauseMs,
                        prefixMs: prefixMs
                    )
                }
            }
            return .gemini(
                .init(
                    cosmoVad: cosmoVad,
                    endOfSpeechSensitivity: endOfSpeechSensitivity,
                    includeThoughts: includeThoughts,
                    maxOutputTokens: maxOutputTokens,
                    prefixPaddingMs: prefixPaddingMs,
                    provider: .gemini,
                    silenceDurationMs: silenceDurationMs,
                    temperature: temperature,
                    thinkingLevel: thinkingLevel,
                    turnDetection: wireTurnDetection
                ))
        case .openaiMini:
            return .openaiMini(.init(provider: .openaiMini))
        case let .grok(silenceDurationMs, prefixPaddingMs):
            return .grok(
                .init(
                    prefixPaddingMs: prefixPaddingMs,
                    provider: .grok,
                    silenceDurationMs: silenceDurationMs
                ))
        case let .openai(turnDetection):
            switch turnDetection {
            case nil:
                return .openai(.init(provider: .openai))
            case let .serverVad(silenceDurationMs, prefixPaddingMs):
                return .openai(
                    .init(
                        prefixPaddingMs: prefixPaddingMs,
                        provider: .openai,
                        silenceDurationMs: silenceDurationMs,
                        turnDetection: .serverVad
                    ))
            case let .semanticVad(eagerness):
                return .openai(
                    .init(
                        eagerness: eagerness,
                        provider: .openai,
                        turnDetection: .semanticVad
                    ))
            }
        }
    }
}

/// One entry of an agent's tool set.
public enum AgentTool: Sendable, Equatable {
    /// A client-executed tool, self-described at session start. The
    /// server runs it by invoking this client over the transport
    /// (LiveKit RPC); declare a ``handler`` to make it executable.
    /// ``parameters`` is the JSON Schema for the tool's arguments
    /// (restricted dialect, top-level ``type: "object"``). A spec
    /// without a handler is still declared to the agent but cannot
    /// be executed — its invocation surfaces only as a
    /// ``RealtimeSession/Event/toolInvocation(_:)`` observability
    /// event.
    case client(
        name: String,
        description: String,
        parameters: [String: JSONValue],
        handler: ClientToolHandler? = nil
    )
    /// A client-executed tool whose work runs in the background. Declared
    /// and sent identically to ``client(name:description:parameters:handler:)``
    /// (same wire shape); the background behavior is entirely client-side.
    /// Its handler receives a ``ClientToolJob``: it acks the call immediately
    /// (``ClientToolJob/ack(note:)``) so the session isn't blocked, then
    /// delivers the result later (``ClientToolJob/complete(result:summary:)``
    /// / ``ClientToolJob/fail(error:)``). Use it for a tool whose execution
    /// can outlast the voice turn (an export, a scan, a wait for input).
    case backgroundClient(
        name: String,
        description: String,
        parameters: [String: JSONValue],
        handler: BackgroundClientToolHandler
    )
    /// Opt-in to the server-executed web-search tool. Zero-config —
    /// the server owns the model-facing declaration. Resolved-flow
    /// vocabulary.
    case webSearch
    /// Opt-in to the server-executed frame-examination tool (reads the
    /// freshest camera/screen frame at full resolution). Zero-config;
    /// resolved-flow vocabulary.
    case examineImage
    /// Opt-in to the server-executed object locator that returns boxes —
    /// one per matching instance. Pairs with a client renderer
    /// (`cosmo_sdk_draw_box`): the model picks one of the candidates and
    /// passes it on. Zero-config; resolved-flow vocabulary.
    case detectObjects
    /// The point-returning sibling of ``detectObjects``, pairing with
    /// `cosmo_sdk_draw_point`.
    case pointAtObject
    /// A client tool the SDK ships, carrying its own handler.
    ///
    /// Its payload has no public initializer, so this case can only come
    /// from an SDK factory (``drawBox(onDraw:)`` and friends). That is
    /// what makes the ``cosmo_sdk_`` reservation hold: a caller cannot
    /// hand-build a spec under an SDK tool's name, not even the exact
    /// name, because they cannot build this payload at all.
    case sdkClient(SDKClientTool)
    /// The host's screen, offered to the server-executed locator
    /// (`cosmo_screen_locate`) rather than to the model. Alone among the
    /// cases here it is never advertised: it registers an RPC handler the
    /// locator drives, and declaring it is what asks for the locator.
    /// Its payload has no public initializer either — build it with
    /// ``screenLocate(capture:)``.
    case screenLocate(ScreenLocateTool)

    /// Client-tool names the SDK reserves for the tools it ships itself
    /// (``drawBox(onDraw:)`` and friends). A caller's own tool must not use
    /// the prefix: the SDK owns those names and schemas, so a collision would
    /// silently replace an SDK tool with something the model was told behaves
    /// differently.
    ///
    /// Server tools hold the wider ``cosmo_`` namespace; this is the slice
    /// carved out of it for client-executed SDK tools.
    public static let sdkToolNamePrefix = "cosmo_sdk_"

    public var name: String {
        switch self {
        case let .client(name, _, _, _): return name
        case let .backgroundClient(name, _, _, _): return name
        case let .sdkClient(tool): return tool.name
        case .webSearch: return "web_search"
        case .examineImage: return "examine_image"
        case .detectObjects: return "cosmo_detect_objects"
        case .pointAtObject: return "cosmo_point_at_object"
        case .screenLocate: return "screen_locate"
        }
    }

    /// The local handler the session would register for this tool — so a
    /// host can invoke its own declared tool the way the session will.
    /// Reading a handler back cannot forge one: an SDK-shipped tool's still
    /// only comes from its factory. ``nil`` for handler-less specs, deferred
    /// background handlers, and server-tool opt-ins.
    public var clientToolHandler: ClientToolHandler? {
        switch self {
        case let .client(_, _, _, handler): return handler
        case let .sdkClient(tool): return tool.handler
        case .backgroundClient, .webSearch, .examineImage, .detectObjects,
            .pointAtObject, .screenLocate:
            return nil
        }
    }

    public static func == (lhs: AgentTool, rhs: AgentTool) -> Bool {
        switch (lhs, rhs) {
        case let (.client(ln, ld, lp, _), .client(rn, rd, rp, _)):
            // Handlers are local-only closures, excluded from
            // equality (and from the wire).
            return ln == rn && ld == rd && lp == rp
        case let (.backgroundClient(ln, ld, lp, _), .backgroundClient(rn, rd, rp, _)):
            return ln == rn && ld == rd && lp == rp
        case let (.sdkClient(l), .sdkClient(r)):
            return l == r
        case (.webSearch, .webSearch), (.examineImage, .examineImage),
            (.detectObjects, .detectObjects), (.pointAtObject, .pointAtObject),
            // Zero-config like the opt-ins above: two capture slots declare
            // the same capability, and the handler behind them is
            // local-only, as with every other handler here.
            (.screenLocate, .screenLocate):
            return true
        // Every case is spelled out rather than caught by `default`: a
        // case added to the enum then fails to compile here instead of
        // silently comparing unequal to itself.
        case (.client, _), (.backgroundClient, _), (.sdkClient, _),
            (.webSearch, _), (.examineImage, _), (.detectObjects, _),
            (.pointAtObject, _), (.screenLocate, _):
            return false
        }
    }
}

/// The assembled per-session wire config: the created agent's fields plus
/// one run's params, flattened for ``RealtimeAgent/start(resumeSessionId:maxSessionSeconds:storeRecording:storeAudio:storeTranscript:storeVideo:micMuted:rpcHandlers:)``.
/// Public callers never touch it — ``RealtimeClient/agent(instructions:model:modelOptions:voice:audio:tools:interruptionSensitivity:greeting:skills:mcp:hooks:)``
/// and ``RealtimeAgent/start(resumeSessionId:maxSessionSeconds:storeRecording:storeAudio:storeTranscript:storeVideo:micMuted:rpcHandlers:)``
/// assemble it.
///
/// Every field is optional: the server applies neutral defaults for
/// anything left unset, and unset fields stay off the wire entirely.
struct SessionConfig: Sendable, Equatable {
    typealias Voice = VoiceConfig
    typealias Ambience = AmbienceConfig
    typealias Audio = AudioConfig
    typealias Tool = AgentTool
    typealias ModelOptions = CosmoRealtime.ModelOptions
    typealias GeminiTurnDetection = CosmoRealtime.ModelOptions.GeminiTurnDetection
    typealias OpenAITurnDetection = CosmoRealtime.ModelOptions.OpenAITurnDetection
    typealias InterruptionSensitivity = CosmoRealtime.InterruptionSensitivity
    typealias ThinkingLevel = CosmoRealtime.ThinkingLevel
    typealias EndOfSpeechSensitivity = CosmoRealtime.EndOfSpeechSensitivity
    typealias SemanticEagerness = CosmoRealtime.SemanticEagerness
    typealias TurnDetectionMode = CosmoRealtime.TurnDetectionMode

    static let sdkToolNamePrefix = AgentTool.sdkToolNamePrefix

    /// Machine handle of a workspace catalog agent to run (lowercase
    /// ``[a-z0-9-]``, e.g. ``"driver-pay"``). The stored agent config runs
    /// verbatim; a stored-config agent field set alongside the handle
    /// throws ``RealtimeSessionError/invalidPayload(_:)`` at start — only
    /// ``agentInputs``, ``tools``, and ``voice`` may accompany it.
    /// ``nil`` runs the inline per-field config with no catalog agent.
    var agentName: String?
    /// String inputs for the referenced agent (template placeholders).
    /// Valid only alongside ``agentName``.
    var agentInputs: [String: String]?
    /// Provider/model selection. ``nil`` lets the server choose its
    /// default; unavailable values are rejected explicitly at session
    /// start.
    var model: String?
    /// Provider-scoped model knobs (sampling, reasoning depth, turn-taking),
    /// discriminated on provider. Each knob is honored only by its provider,
    /// so an illegal pairing is unrepresentable. ``nil`` keeps every provider
    /// default; ``model`` selects the concrete model within the provider.
    var modelOptions: ModelOptions?
    /// How the agent sounds — prebuilt voice id and speaking style.
    /// ``nil`` keeps the server defaults for both.
    var voice: Voice?
    /// The agent's audio pipeline — output emission, inbound noise
    /// cancellation, and the ambience bed. ``nil`` keeps every server
    /// default (audio on, cancellation on, no ambience).
    var audio: Audio?
    /// System instructions. Replaces the server's neutral default when
    /// set.
    var instructions: String?
    /// Tool set for the session: client-executed specs this client
    /// fulfils locally, plus opt-in server tools by name. ``nil`` (the
    /// default) inherits the client-level default tools; an explicit empty
    /// array runs the session with no tools (overriding any default); a
    /// non-empty array is used as-is.
    var tools: [Tool]?
    /// How readily the user's speech interrupts the agent. ``nil`` keeps
    /// the server default.
    var interruptionSensitivity: InterruptionSensitivity?
    /// Opening line the assistant speaks first, voiced server-side as soon
    /// as the model session opens — before the client even receives
    /// ``ready``. ``nil`` keeps the wait-for-user behavior.
    var greeting: String?
    /// When set, the server resumes the named prior session. Carried
    /// under ``RealtimeSessionParams/experimental`` — an unstable knob
    /// that may change shape between releases.
    var resumeSessionId: String?
    /// Requested wall-clock cap on the session, in seconds. The server resolves
    /// the effective cap as the minimum of this and its own limits — a client
    /// can only shorten, never extend. The effective value is echoed on
    /// ``ready``. ``nil`` requests no client-side cap.
    var maxSessionSeconds: Int?
    /// Persist this run's recording artifacts (audio/video/transcript/tool
    /// events) server-side. Per-run option, not agent config. ``nil`` stores
    /// as much as the account's consents allow. The per-artifact properties
    /// below win over this one.
    var storeRecording: Bool?
    /// Persist this run's audio. Narrowing only: a session can request less
    /// storage than the account permits, never more. ``nil`` defers to
    /// ``storeRecording``, then to those consents.
    var storeAudio: Bool?
    /// Persist this run's transcript and tool-call events. Same contract as
    /// ``storeAudio``.
    var storeTranscript: Bool?
    /// Persist this run's screen-share video and screenshots. Same contract
    /// as ``storeAudio``.
    var storeVideo: Bool?
    /// One list, two kinds of hooks: in-process client hooks built by the
    /// seam factories (``sessionStart(_:)``, ``preToolUse(matcher:_:)``, …;
    /// list order is fold order) and declarative server hooks
    /// (``Hook/server(_:)`` wrapping a ``SilenceTimeout``) the server
    /// executes even if this process dies mid-call. Server hooks serialize
    /// in the agent block and take part in equality; client callbacks are
    /// local-only (like client-tool handlers).
    var hooks: [Hook]?

    init(
        agentName: String? = nil,
        agentInputs: [String: String]? = nil,
        model: String? = nil,
        modelOptions: ModelOptions? = nil,
        voice: Voice? = nil,
        audio: Audio? = nil,
        instructions: String? = nil,
        tools: [Tool]? = nil,
        interruptionSensitivity: InterruptionSensitivity? = nil,
        greeting: String? = nil,
        resumeSessionId: String? = nil,
        maxSessionSeconds: Int? = nil,
        storeRecording: Bool? = nil,
        storeAudio: Bool? = nil,
        storeTranscript: Bool? = nil,
        storeVideo: Bool? = nil,
        hooks: [Hook]? = nil
    ) {
        self.agentName = agentName
        self.agentInputs = agentInputs
        self.model = model
        self.modelOptions = modelOptions
        self.voice = voice
        self.audio = audio
        self.instructions = instructions
        self.tools = tools
        self.interruptionSensitivity = interruptionSensitivity
        self.greeting = greeting
        self.resumeSessionId = resumeSessionId
        self.maxSessionSeconds = maxSessionSeconds
        self.storeRecording = storeRecording
        self.storeAudio = storeAudio
        self.storeTranscript = storeTranscript
        self.storeVideo = storeVideo
        self.hooks = hooks
    }

    static func == (lhs: SessionConfig, rhs: SessionConfig) -> Bool {
        // hooks is local-only (closures), excluded from equality — same
        // pattern as client-tool handlers in Tool.==.
        lhs.agentName == rhs.agentName
            && lhs.agentInputs == rhs.agentInputs
            && lhs.model == rhs.model
            && lhs.modelOptions == rhs.modelOptions
            && lhs.voice == rhs.voice
            && lhs.audio == rhs.audio
            && lhs.instructions == rhs.instructions
            && lhs.tools == rhs.tools
            && lhs.interruptionSensitivity == rhs.interruptionSensitivity
            && lhs.greeting == rhs.greeting
            && lhs.resumeSessionId == rhs.resumeSessionId
            && lhs.maxSessionSeconds == rhs.maxSessionSeconds
            && lhs.storeRecording == rhs.storeRecording
            && lhs.storeAudio == rhs.storeAudio
            && lhs.storeTranscript == rhs.storeTranscript
            && lhs.storeVideo == rhs.storeVideo
            && lhs.serverHooks == rhs.serverHooks
    }
}

/// A client tool the SDK ships: the declaration it owns plus the handler a
/// caller supplied. Construct one through an SDK factory — there is no
/// public initializer, which is precisely what keeps the ``cosmo_sdk_``
/// namespace closed.
public struct SDKClientTool: Sendable, Equatable {
    /// Two are equal when they declare the same tool. The handler is a
    /// local-only closure, excluded here as it is from the wire.
    public static func == (lhs: SDKClientTool, rhs: SDKClientTool) -> Bool {
        lhs.name == rhs.name
            && lhs.description == rhs.description
            && lhs.parameters == rhs.parameters
    }

    let name: String
    let description: String
    let parameters: [String: JSONValue]
    let handler: ClientToolHandler

    init(
        name: String,
        description: String,
        parameters: [String: JSONValue],
        handler: @escaping ClientToolHandler
    ) {
        self.name = name
        self.description = description
        self.parameters = parameters
        self.handler = handler
    }
}

/// An async client-tool handler: `(args) -> result`. ``args`` is the
/// decoded tool-call arguments; the returned object is reported back to
/// the agent as the tool result. Throw to surface a tool error. The
/// handler is local-only — it is excluded from serialization and never
/// crosses the wire.
public typealias ClientToolHandler =
    @Sendable ([String: JSONValue]) async throws -> [String: JSONValue]

extension SessionConfig {
    /// Caught here rather than at the server's 422 so the message names the
    /// offending tool and arrives while the caller is still looking at the
    /// code that declared it.
    func assertNoReservedToolNames() throws {
        for tool in tools ?? [] {
            // Both hand-built cases, because they serialize to the same
            // ``kind: "client"`` wire shape — checking only ``.client``
            // would leave ``.backgroundClient`` free to take an SDK name.
            // ``.sdkClient`` is exempt by construction, not by name: a
            // caller cannot build one, so there is nothing to allow-list
            // and no way to shadow an SDK tool by matching its name exactly.
            let declaredName: String?
            switch tool {
            case let .client(name, _, _, _): declaredName = name
            case let .backgroundClient(name, _, _, _): declaredName = name
            case .sdkClient, .webSearch, .examineImage, .detectObjects,
                .pointAtObject, .screenLocate:
                declaredName = nil
            }
            guard let name = declaredName, name.hasPrefix(AgentTool.sdkToolNamePrefix)
            else { continue }
            throw RealtimeSessionError.invalidPayload(
                "\(name): the \(AgentTool.sdkToolNamePrefix) prefix is reserved for "
                + "tools the SDK ships — rename your tool"
            )
        }
    }

    /// The server half of the unified ``hooks`` list — wire config for the
    /// agent block; ``nil`` when there are none (stays off the wire).
    var serverHooks: [SilenceTimeout]? {
        let server = splitHooks(hooks ?? []).server
        return server.isEmpty ? nil : server
    }

    /// The in-process half of the unified ``hooks`` list, as the dispatch
    /// engine; ``nil`` when there are no client hooks.
    var hookEngine: HookEngine? {
        splitHooks(hooks ?? []).engine
    }

    /// The ``session-config`` wire payload: the SDK identity and only
    /// the fields the caller actually set. Agent-scoped knobs nest under
    /// ``RealtimeSessionConfig/agent``; session-scoped ones under
    /// ``RealtimeSessionConfig/session``. A sub-object with no set fields
    /// stays off the wire entirely, same as an unset leaf.
    func wirePayload() throws -> CosmoRealtimeAPI.Components.Schemas.SessionConfig {
        try assertNoReservedToolNames()
        let agent: CosmoRealtimeAPI.Components.Schemas.SessionConfig.AgentPayload?
        if let agentName {
            // The catalog variant carries only per-run ride-alongs; a
            // stored-config field alongside the handle is a client-side
            // error, never silently dropped.
            let storedConfigFields: [(String, Bool)] = [
                ("model", model != nil),
                ("modelOptions", modelOptions != nil),
                ("audio", audio != nil),
                ("instructions", instructions != nil),
                ("interruptionSensitivity", interruptionSensitivity != nil),
                ("greeting", greeting != nil),
                ("hooks (server)", !(serverHooks ?? []).isEmpty),
            ]
            let offending = storedConfigFields.filter(\.1).map(\.0)
            guard offending.isEmpty else {
                throw RealtimeSessionError.invalidPayload(
                    "a catalog agent runs its stored config verbatim — remove: "
                        + offending.joined(separator: ", ")
                )
            }
            // An explicit empty tool set and an unset one both serialize as
            // absent; the server applies its neutral default for absent.
            let wireTools = try tools.flatMap { specs in
                specs.isEmpty ? nil : try specs.map { try $0.catalogWirePayload() }
            }
            agent = .catalog(
                .init(
                    inputs: agentInputs.map { .init(additionalProperties: $0) },
                    name: agentName,
                    tools: wireTools,
                    _type: .catalog,
                    voice: voice?.wire
                )
            )
        } else {
            // An explicit empty tool set and an unset one both serialize as
            // absent; the server applies its neutral default for absent.
            let wireTools = try tools.flatMap { specs in
                specs.isEmpty ? nil : try specs.map { try $0.inlineWirePayload() }
            }
            let inline = CosmoRealtimeAPI.Components.Schemas.InlineAgentConfig(
                audio: audio?.wire,
                greeting: greeting,
                hooks: serverHooks,
                instructions: instructions,
                interruptionSensitivity: interruptionSensitivity,
                model: model,
                modelOptions: modelOptions?.wire,
                tools: wireTools,
                _type: .inline,
                voice: voice?.wire
            )
            // An inline block carrying only its tag is the neutral default
            // agent — omit the block entirely.
            agent = inline == .init(_type: .inline) ? nil : .inline(inline)
        }
        let session = CosmoRealtimeAPI.Components.Schemas.SessionParams(
            experimental: resumeSessionId.map { .init(resumeSessionId: $0) },
            maxSessionSeconds: maxSessionSeconds,
            storeAudio: storeAudio,
            storeRecording: storeRecording,
            storeTranscript: storeTranscript,
            storeVideo: storeVideo
        )
        return CosmoRealtimeAPI.Components.Schemas.SessionConfig(
            agent: agent,
            sdk: .init(name: RealtimeSession.sdkName, version: RealtimeSession.sdkVersion),
            session: session == .init() ? nil : session,
            _type: .sessionConfig
        )
    }

    /// Client tools that carry a local handler, keyed by tool name. The
    /// transport registers an RPC method per entry so the agent can
    /// invoke them.
    func clientToolHandlers() -> [String: ClientToolHandler] {
        var handlers: [String: ClientToolHandler] = [:]
        for tool in tools ?? [] {
            if case let .client(name, _, _, handler) = tool, let handler {
                handlers[name] = handler
            }
            if case let .sdkClient(sdkTool) = tool {
                handlers[sdkTool.name] = sdkTool.handler
            }
        }
        return handlers
    }

    /// Handlers registered by wire method name but never advertised — the
    /// ``AgentTool/screenLocate(_:)`` slot, which a server tool drives directly.
    /// Keyed by RPC method rather than tool name, since the model never sees it.
    func rpcOnlyHandlers() -> [String: ClientToolHandler] {
        var handlers: [String: ClientToolHandler] = [:]
        for case let .screenLocate(capture) in tools ?? [] {
            handlers[ScreenLocateTool.rpcMethod] = capture.handler()
        }
        return handlers
    }

    /// The capture slots this config declares, so the session can bind their
    /// byte-stream publish once its transport is up.
    var screenLocateTools: [ScreenLocateTool] {
        (tools ?? []).compactMap { tool in
            guard case let .screenLocate(capture) = tool else { return nil }
            return capture
        }
    }

    /// Background client tools that carry a handler, keyed by tool name. The
    /// transport registers a deferred RPC method per entry.
    func backgroundClientToolHandlers() -> [String: BackgroundClientToolHandler] {
        var handlers: [String: BackgroundClientToolHandler] = [:]
        for tool in tools ?? [] {
            if case let .backgroundClient(name, _, _, handler) = tool {
                handlers[name] = handler
            }
        }
        return handlers
    }
}

extension AgentTool {
    // The generator emits a structurally-identical but distinct tools
    // payload type per agent variant, so each variant gets its own mapping.
    fileprivate func inlineWirePayload() throws
        -> CosmoRealtimeAPI.Components.Schemas.InlineAgentConfig.ToolsPayloadPayload
    {
        switch self {
        case .sdkClient(let sdkTool):
            return .client(
                .init(
                    description: sdkTool.description,
                    kind: .client,
                    name: sdkTool.name,
                    parameters: .init(additionalProperties: try objectContainer(from: sdkTool.parameters))
                )
            )
        case .client(let name, let description, let parameters, _),
            .backgroundClient(let name, let description, let parameters, _):
            // A background client tool is declared identically to a plain one;
            // the deferral is inferred server-side from the reply.
            return .client(
                .init(
                    description: description,
                    kind: .client,
                    name: name,
                    parameters: .init(additionalProperties: try objectContainer(from: parameters))
                )
            )
        case .webSearch:
            return .webSearch(.init(kind: .webSearch))
        case .examineImage:
            return .examineImage(.init(kind: .examineImage))
        case .detectObjects:
            return .detectObjects(.init(kind: .detectObjects))
        case .pointAtObject:
            return .pointAtObject(.init(kind: .pointAtObject))
        case .screenLocate:
            return .screenLocate(.init(kind: .screenLocate))
        }
    }

    fileprivate func catalogWirePayload() throws
        -> CosmoRealtimeAPI.Components.Schemas.CatalogAgentConfig.ToolsPayloadPayload
    {
        switch self {
        case .sdkClient(let sdkTool):
            return .client(
                .init(
                    description: sdkTool.description,
                    kind: .client,
                    name: sdkTool.name,
                    parameters: .init(additionalProperties: try objectContainer(from: sdkTool.parameters))
                )
            )
        case .client(let name, let description, let parameters, _),
            .backgroundClient(let name, let description, let parameters, _):
            return .client(
                .init(
                    description: description,
                    kind: .client,
                    name: name,
                    parameters: .init(additionalProperties: try objectContainer(from: parameters))
                )
            )
        case .webSearch:
            return .webSearch(.init(kind: .webSearch))
        case .examineImage:
            return .examineImage(.init(kind: .examineImage))
        case .detectObjects:
            return .detectObjects(.init(kind: .detectObjects))
        case .pointAtObject:
            return .pointAtObject(.init(kind: .pointAtObject))
        case .screenLocate:
            return .screenLocate(.init(kind: .screenLocate))
        }
    }
}

/// Bridge a typed ``JSONValue`` object into the generated
/// ``OpenAPIObjectContainer`` via a JSON round-trip — both sides are
/// Codable, so this avoids any untyped ``[String: Any]`` step.
func objectContainer(from object: [String: JSONValue]) throws -> OpenAPIRuntime.OpenAPIObjectContainer {
    let data = try JSONEncoder().encode(object)
    return try JSONDecoder().decode(OpenAPIRuntime.OpenAPIObjectContainer.self, from: data)
}
