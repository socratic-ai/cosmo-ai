import CosmoRealtimeAPI
import Foundation

// Clean names for the generated wire payload types so consumers never
// spell the ``CosmoRealtimeAPI.Components.Schemas`` namespace. The
// generated structs are the source of truth for field shapes — they
// regenerate from ``external-openapi.json`` on every build.
extension RealtimeSession {
    public typealias Ready = CosmoRealtimeAPI.Components.Schemas.ReadyEvent
    public typealias TranscriptDelta = CosmoRealtimeAPI.Components.Schemas.TranscriptDeltaEvent
    public typealias ModelText = CosmoRealtimeAPI.Components.Schemas.ModelTextEvent
    public typealias TurnComplete = CosmoRealtimeAPI.Components.Schemas.TurnCompleteEvent
    public typealias ToolCall = CosmoRealtimeAPI.Components.Schemas.ToolCallEvent
    public typealias ToolDispatchStarted = CosmoRealtimeAPI.Components.Schemas.ToolDispatchStartedEvent
    public typealias ToolResult = CosmoRealtimeAPI.Components.Schemas.ToolResultEvent
    public typealias ToolInvocation = CosmoRealtimeAPI.Components.Schemas.ToolInvocationEvent
    public typealias Reconnecting = CosmoRealtimeAPI.Components.Schemas.ReconnectingEvent
    public typealias ErrorEvent = CosmoRealtimeAPI.Components.Schemas.ErrorEvent
    public typealias ErrorCode = CosmoRealtimeAPI.Components.Schemas.ErrorCode
    public typealias RejectedTool = CosmoRealtimeAPI.Components.Schemas.RejectedTool
    public typealias ResolvedAgent = CosmoRealtimeAPI.Components.Schemas.ResolvedAgent
    public typealias CosmoUsage = CosmoRealtimeAPI.Components.Schemas.UsageEvent
    public typealias UserSpeechTimeout = CosmoRealtimeAPI.Components.Schemas.UserSpeechTimeoutEvent

    /// Terminal sentinel for ``Event/sessionEnded(_:)``. The server
    /// publishes a ``session-ended`` wire frame best-effort before a
    /// deliberate teardown; the SDK latches its reason and never surfaces
    /// the frame mid-stream. The transport close remains the terminal
    /// signal — the SDK synthesizes this local sentinel as the final
    /// element of ``RealtimeSession/events``, carrying the latched reason
    /// when one arrived.
    public struct SessionEnded: Sendable, Equatable {
        /// Why the session ended, when known.
        public let reason: String?
        public init(reason: String?) { self.reason = reason }
    }

    /// One server event from ``RealtimeSession/events``.
    ///
    /// Forward compatibility: a frame with an unrecognized ``type`` —
    /// or one whose payload fails to decode against the known schema —
    /// surfaces as ``unknown(rawType:payload:)`` and the session keeps
    /// running. Decode failure is never terminal.
    ///
    /// ``sessionEnded(_:)`` is the final element of the stream; the
    /// sequence finishes after it.
    @frozen
    public enum Event: Sendable {
        /// The upstream session is established and the agent is ready
        /// for input. Carries the ``sessionId`` and any soft-rejected
        /// tool specs.
        case ready(Ready)
        /// Streaming transcript fragment (delta while ``isFinal`` is
        /// false; cumulative full text on the final event).
        case transcript(TranscriptDelta)
        /// Text-channel fragment from the model (distinct from the
        /// spoken-audio transcript).
        case modelText(ModelText)
        case turnComplete(TurnComplete)
        case userStartedSpeaking
        case userStoppedSpeaking
        case botStartedSpeaking
        case botStoppedSpeaking
        case botLlmStarted
        case botLlmStopped
        case botTtsStarted
        case botTtsStopped
        /// Model decided to invoke a server-executed tool.
        case toolCall(ToolCall)
        case toolDispatchStarted(ToolDispatchStarted)
        case toolResult(ToolResult)
        /// Observability: the server invoked a declared client tool.
        /// Execution and the reply happen via the tool's local handler
        /// over the transport (LiveKit RPC), not a send on this stream.
        case toolInvocation(ToolInvocation)
        /// Server is transparently rotating the upstream session.
        case reconnecting(Reconnecting)
        /// A first-party Cosmo event (token usage). The
        /// server emits these for first-party sessions; delivery is not gated on
        /// the client having sent a `cosmo` block on `session-config`.
        case cosmo(CosmoEvent)
        /// Observability: a server-runtime silence hook fired. ``action``
        /// reports what the server already did (say / end call).
        case userSpeechTimeout(UserSpeechTimeout)
        /// Terminal: the session is over; the stream finishes after
        /// this element.
        case sessionEnded(SessionEnded)
        /// Recoverable or terminal error — switch on ``ErrorEvent/fatal``.
        case error(ErrorEvent)
        case pong
        /// A frame the SDK could not interpret: ``rawType`` is the wire
        /// ``type`` (``nil`` when the frame was not decodable JSON at
        /// all); ``payload`` is the raw frame bytes.
        case unknown(rawType: String?, payload: Data)
    }
}

extension RealtimeSession {
    /// First-party Cosmo events, all carried in the single
    /// ``Event/cosmo(_:)`` case. The wire types ride the ``cosmo.*``
    /// namespace.
    @frozen
    public enum CosmoEvent: Sendable {
        /// Cumulative token usage for the session.
        case usage(CosmoUsage)
    }
}

extension RealtimeSession {
    /// Result of classifying one raw inbound frame.
    enum ClassifiedFrame {
        case envelopeChunk(envelopeId: String, seq: Int, total: Int, data: String)
        /// The server's best-effort ``session-ended`` frame: latched by the
        /// session for the terminal reason, never yielded as a stream event.
        case serverSessionEnded(reason: String?)
        case event(Event)
    }

    /// Decode a raw server frame into an ``Event`` (or an envelope
    /// chunk for the reassembler). Tolerant by construction: anything
    /// unrecognized or undecodable becomes ``Event/unknown(rawType:payload:)``.
    static func classifyFrame(_ data: Data) -> ClassifiedFrame {
        struct TypeProbe: Decodable {
            let type: String
        }
        let decoder = JSONDecoder()
        guard let probe = try? decoder.decode(TypeProbe.self, from: data) else {
            return .event(.unknown(rawType: nil, payload: data))
        }

        func decodePayload<T: Decodable>(_ type: T.Type, _ project: (T) -> Event) -> ClassifiedFrame {
            guard let value = try? decoder.decode(type, from: data) else {
                log.warning("frame decode failed type=\(probe.type, privacy: .public); surfacing as unknown event")
                return .event(.unknown(rawType: probe.type, payload: data))
            }
            return .event(project(value))
        }

        switch probe.type {
        case "server-envelope-chunk":
            struct Chunk: Decodable {
                let envelope_id: String
                let seq: Int
                let total: Int
                let data: String
            }
            guard let chunk = try? decoder.decode(Chunk.self, from: data) else {
                return .event(.unknown(rawType: probe.type, payload: data))
            }
            return .envelopeChunk(
                envelopeId: chunk.envelope_id,
                seq: chunk.seq,
                total: chunk.total,
                data: chunk.data
            )
        case "ready":
            return decodePayload(Ready.self) { .ready($0) }
        case "transcript":
            return decodePayload(TranscriptDelta.self) { .transcript($0) }
        case "model-text":
            return decodePayload(ModelText.self) { .modelText($0) }
        case "turn-complete":
            return decodePayload(TurnComplete.self) { .turnComplete($0) }
        case "user-started-speaking":
            return .event(.userStartedSpeaking)
        case "user-stopped-speaking":
            return .event(.userStoppedSpeaking)
        case "bot-started-speaking":
            return .event(.botStartedSpeaking)
        case "bot-stopped-speaking":
            return .event(.botStoppedSpeaking)
        case "bot-llm-started":
            return .event(.botLlmStarted)
        case "bot-llm-stopped":
            return .event(.botLlmStopped)
        case "bot-tts-started":
            return .event(.botTtsStarted)
        case "bot-tts-stopped":
            return .event(.botTtsStopped)
        case "tool-call":
            return decodePayload(ToolCall.self) { .toolCall($0) }
        case "tool-dispatch-started":
            return decodePayload(ToolDispatchStarted.self) { .toolDispatchStarted($0) }
        case "tool-result":
            return decodePayload(ToolResult.self) { .toolResult($0) }
        case "tool-invocation":
            return decodePayload(ToolInvocation.self) { .toolInvocation($0) }
        case "reconnecting":
            return decodePayload(Reconnecting.self) { .reconnecting($0) }
        case "cosmo.usage":
            return decodePayload(CosmoUsage.self) { .cosmo(.usage($0)) }
        case "error":
            return decodePayload(ErrorEvent.self) { .error($0) }
        case "user-speech-timeout":
            return decodePayload(UserSpeechTimeout.self) { .userSpeechTimeout($0) }
        case "session-ended":
            guard
                let ended = try? decoder.decode(
                    CosmoRealtimeAPI.Components.Schemas.SessionEndedEvent.self, from: data
                )
            else {
                return .event(.unknown(rawType: probe.type, payload: data))
            }
            return .serverSessionEnded(reason: ended.reason)
        case "pong":
            return .event(.pong)
        default:
            return .event(.unknown(rawType: probe.type, payload: data))
        }
    }
}
