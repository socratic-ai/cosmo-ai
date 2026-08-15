import Foundation
import Testing
@testable import CosmoRealtime

@Suite("SessionConfig")
struct SessionConfigTests {

    private func encodedFields(_ config: SessionConfig) throws -> [String: JSONValue] {
        let data = try JSONEncoder().encode(try config.wirePayload())
        guard case .object(let fields) = try JSONDecoder().decode(JSONValue.self, from: data) else {
            Issue.record("session-config did not encode to a JSON object")
            return [:]
        }
        return fields
    }

    private func object(_ fields: [String: JSONValue], _ key: String) -> [String: JSONValue]? {
        guard case .object(let nested)? = fields[key] else { return nil }
        return nested
    }

    @Test("wire payload carries type and SDK identity; unset fields stay absent")
    func defaultsStayAbsent() throws {
        let fields = try encodedFields(SessionConfig())
        #expect(fields["type"] == .string("session-config"))
        #expect(
            fields["sdk"]
                == .object([
                    "name": .string(RealtimeSession.sdkName),
                    "version": .string(RealtimeSession.sdkVersion),
                ])
        )
        // Empty agent/session sub-objects stay off the wire entirely.
        for absent in ["agent", "session"] {
            #expect(fields[absent] == nil, "expected \(absent) to stay off the wire")
        }
    }

    @Test("the audio block stays off the wire when unset, even with other agent fields set")
    func audioAbsentWhenUnset() throws {
        // The agent block is present (instructions set), but an unset
        // ``audio`` must not put the key on the wire — the server only
        // defaults noise cancellation on when the knob is absent from the
        // audio block's ``model_fields_set``.
        let fields = try encodedFields(SessionConfig(instructions: "Be terse."))
        guard let agent = object(fields, "agent") else {
            Issue.record("expected an agent sub-object, got \(String(describing: fields["agent"]))")
            return
        }
        #expect(agent["instructions"] == .string("Be terse."))
        #expect(
            agent["audio"] == nil,
            "unset audio must stay off the wire so the server defaults apply"
        )
    }

    @Test("explicit noise-cancellation false is emitted so it wins over the server default")
    func explicitNoiseCancellationFalseIsEmitted() throws {
        let fields = try encodedFields(
            SessionConfig(audio: .init(noiseCancellation: false))
        )
        guard let agent = object(fields, "agent") else {
            Issue.record("expected an agent sub-object, got \(String(describing: fields["agent"]))")
            return
        }
        #expect(agent["audio"] == .object(["noise_cancellation": .bool(false)]))
    }

    @Test("an empty ambience object survives serialization — presence enables the bed")
    func emptyAmbienceObjectSurvives() throws {
        let fields = try encodedFields(
            SessionConfig(audio: .init(ambience: .init()))
        )
        guard let agent = object(fields, "agent") else {
            Issue.record("expected an agent sub-object, got \(String(describing: fields["agent"]))")
            return
        }
        #expect(agent["audio"] == .object(["ambience": .object([:])]))
    }

    @Test("set fields serialize under their wire names, nested by scope")
    func setFieldsSerialize() throws {
        let fields = try encodedFields(
            SessionConfig(
                model: "gemini-live",
                modelOptions: .gemini(
                    temperature: 0.7, maxOutputTokens: 4096, thinkingLevel: .high),
                voice: .init(name: "Puck", speakingStyle: "Talk warmly."),
                audio: .init(output: false, noiseCancellation: true),
                instructions: "Be terse.",
                tools: [
                    .client(
                        name: "get_local_time",
                        description: "Returns the local wall-clock time.",
                        parameters: ["type": .string("object")]
                    ),
                    .webSearch,
                ],
                interruptionSensitivity: .high,
                greeting: "Hi, I'm Cosmo.",
                resumeSessionId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
                storeRecording: false
            )
        )
        // Agent-scoped knobs nest under `agent`.
        guard let agent = object(fields, "agent") else {
            Issue.record("expected an agent sub-object, got \(String(describing: fields["agent"]))")
            return
        }
        #expect(agent["model"] == .string("gemini-live"))
        guard let modelOptions = object(agent, "model_options") else {
            Issue.record(
                "expected a model_options sub-object, got \(String(describing: agent["model_options"]))"
            )
            return
        }
        #expect(modelOptions["provider"] == .string("gemini"))
        #expect(modelOptions["temperature"] == .double(0.7))
        #expect(modelOptions["max_output_tokens"] == .int(4096))
        #expect(modelOptions["thinking_level"] == .string("high"))
        #expect(
            agent["voice"]
                == .object([
                    "name": .string("Puck"), "speaking_style": .string("Talk warmly."),
                ])
        )
        #expect(agent["instructions"] == .string("Be terse."))
        #expect(agent["interruption_sensitivity"] == .string("high"))
        #expect(agent["greeting"] == .string("Hi, I'm Cosmo."))
        // Audio is agent config, so the audio block nests under `agent`.
        #expect(
            agent["audio"]
                == .object(["output": .bool(false), "noise_cancellation": .bool(true)])
        )
        // Session-scoped knobs nest under `session`; resume_session_id rides
        // under the experimental knobs object inside it.
        guard let session = object(fields, "session") else {
            Issue.record("expected a session sub-object, got \(String(describing: fields["session"]))")
            return
        }
        #expect(
            session["experimental"]
                == .object(["resume_session_id": .string("0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d")])
        )
        #expect(session["store_recording"] == .bool(false))
        guard case .array(let tools)? = agent["tools"], tools.count == 2 else {
            Issue.record("expected two serialized tool specs, got \(String(describing: agent["tools"]))")
            return
        }
        guard case .object(let clientSpec) = tools[0], case .object(let serverSpec) = tools[1] else {
            Issue.record("tool specs did not encode as objects")
            return
        }
        #expect(clientSpec["kind"] == .string("client"))
        #expect(clientSpec["name"] == .string("get_local_time"))
        #expect(clientSpec["parameters"] == .object(["type": .string("object")]))
        #expect(serverSpec["kind"] == .string("web_search"))
        // Zero-config: the kind is the entire spec.
        #expect(serverSpec.count == 1)
    }

    @Test("Gemini endpointing knobs serialize under their wire names")
    func geminiEndpointingKnobsSerialize() throws {
        let fields = try encodedFields(
            SessionConfig(
                modelOptions: .gemini(
                    includeThoughts: false,
                    endOfSpeechSensitivity: .high,
                    silenceDurationMs: 200,
                    prefixPaddingMs: 100
                )
            )
        )
        guard let agent = object(fields, "agent"),
            let modelOptions = object(agent, "model_options")
        else {
            Issue.record("expected a model_options sub-object under agent")
            return
        }
        #expect(modelOptions["provider"] == .string("gemini"))
        #expect(modelOptions["include_thoughts"] == .bool(false))
        #expect(modelOptions["end_of_speech_sensitivity"] == .string("high"))
        #expect(modelOptions["silence_duration_ms"] == .int(200))
        #expect(modelOptions["prefix_padding_ms"] == .int(100))
        #expect(modelOptions["temperature"] == nil)
    }

    @Test("Gemini cosmoVad selection and its tuning block serialize under their wire names")
    func geminiCosmoVadSerializes() throws {
        let fields = try encodedFields(
            SessionConfig(
                modelOptions: .gemini(
                    turnDetection: .cosmoVad(pauseMs: 250, prefixMs: 300, maxHoldMs: 900)
                )
            )
        )
        guard let agent = object(fields, "agent"),
            let modelOptions = object(agent, "model_options")
        else {
            Issue.record("expected a model_options sub-object under agent")
            return
        }
        #expect(modelOptions["turn_detection"] == .string("cosmo_vad"))
        #expect(
            modelOptions["cosmo_vad"]
                == .object([
                    "pause_ms": .int(250),
                    "prefix_ms": .int(300),
                    "max_hold_ms": .int(900),
                ]))
        #expect(modelOptions["silence_duration_ms"] == nil)

        let serverVad = try encodedFields(
            SessionConfig(modelOptions: .gemini(turnDetection: .serverVad))
        )
        guard let serverAgent = object(serverVad, "agent"),
            let serverOptions = object(serverAgent, "model_options")
        else {
            Issue.record("expected a model_options sub-object under agent")
            return
        }
        #expect(serverOptions["turn_detection"] == .string("server_vad"))
        #expect(serverOptions["cosmo_vad"] == nil)
    }

    @Test("an unconfigured OpenAI block carries only the discriminator")
    func openAIDefaultsStayAbsent() throws {
        let fields = try encodedFields(SessionConfig(modelOptions: .openai()))
        guard let agent = object(fields, "agent") else {
            Issue.record("expected an agent sub-object")
            return
        }
        #expect(agent["model_options"] == .object(["provider": .string("openai")]))
    }

    @Test("each OpenAI turn detector serializes only the knobs it reads")
    func openAITurnDetectionSerializes() throws {
        let serverVad = try encodedFields(
            SessionConfig(
                modelOptions: .openai(
                    turnDetection: .serverVad(silenceDurationMs: 200, prefixPaddingMs: 100)
                )
            )
        )
        guard let agent = object(serverVad, "agent"),
            let modelOptions = object(agent, "model_options")
        else {
            Issue.record("expected a model_options sub-object under agent")
            return
        }
        #expect(modelOptions["turn_detection"] == .string("server_vad"))
        #expect(modelOptions["silence_duration_ms"] == .int(200))
        #expect(modelOptions["prefix_padding_ms"] == .int(100))
        #expect(modelOptions["eagerness"] == nil)

        let semanticVad = try encodedFields(
            SessionConfig(modelOptions: .openai(turnDetection: .semanticVad(eagerness: .high)))
        )
        guard let semanticAgent = object(semanticVad, "agent"),
            let semanticOptions = object(semanticAgent, "model_options")
        else {
            Issue.record("expected a model_options sub-object under agent")
            return
        }
        #expect(semanticOptions["turn_detection"] == .string("semantic_vad"))
        #expect(semanticOptions["eagerness"] == .string("high"))
        #expect(semanticOptions["silence_duration_ms"] == nil)
        #expect(semanticOptions["prefix_padding_ms"] == nil)
    }

    @Test("client-tool handlers are local-only and never reach the wire")
    func handlersStayLocal() throws {
        let handler: ClientToolHandler = { _ in ["ok": .bool(true)] }
        let config = SessionConfig(
            tools: [
                .client(
                    name: "get_local_time",
                    description: "Returns the local wall-clock time.",
                    parameters: ["type": .string("object")],
                    handler: handler
                )
            ]
        )
        #expect(config.clientToolHandlers().keys.sorted() == ["get_local_time"])
        let fields = try encodedFields(config)
        guard let agent = object(fields, "agent"),
            case .array(let tools)? = agent["tools"], case .object(let spec) = tools[0]
        else {
            Issue.record("expected one serialized client-tool spec under agent")
            return
        }
        #expect(spec["handler"] == nil, "handler must not serialize onto the wire")
    }

    @Test("catalog agent serializes as agent.name + agent.inputs")
    func catalogAgentSerializes() throws {
        let fields = try encodedFields(
            SessionConfig(
                agentName: "driver-pay",
                agentInputs: ["caller_name": "Sam", "city": "NYC"]
            )
        )
        guard let agent = object(fields, "agent") else {
            Issue.record("expected an agent sub-object, got \(String(describing: fields["agent"]))")
            return
        }
        #expect(agent["type"] == .string("catalog"))
        #expect(agent["name"] == .string("driver-pay"))
        #expect(
            agent["inputs"]
                == .object(["caller_name": .string("Sam"), "city": .string("NYC")])
        )
        #expect(agent.count == 3, "no other keys may ride along: \(agent.keys.sorted())")
    }

    @Test("a bare catalog launch serializes only the tag and agent.name; unset stays absent")
    func bareCatalogAgentSerializes() throws {
        let fields = try encodedFields(SessionConfig(agentName: "driver-pay"))
        #expect(
            object(fields, "agent")
                == ["type": .string("catalog"), "name": .string("driver-pay")]
        )
    }

    @Test("a stored-config field alongside a catalog launch throws instead of riding along")
    func storedConfigFieldWithCatalogAgentThrows() throws {
        let config = SessionConfig(
            agentName: "driver-pay", audio: .init(noiseCancellation: true)
        )
        #expect(throws: RealtimeSessionError.self) {
            try config.wirePayload()
        }
    }

    @Test("the per-run voice rides alongside a catalog launch")
    func catalogVoiceRidesAlong() throws {
        let fields = try encodedFields(
            SessionConfig(agentName: "driver-pay", voice: .init(name: "Puck"))
        )
        guard let agent = object(fields, "agent") else {
            Issue.record("expected an agent sub-object, got \(String(describing: fields["agent"]))")
            return
        }
        #expect(agent["voice"] == .object(["name": .string("Puck")]))
    }

}

extension SessionConfigTests {
    @Test("typed server opt-ins serialize as bare kinds")
    func typedServerOptInsSerializeAsKinds() throws {
        let config = SessionConfig(
            instructions: "Be helpful.",
            tools: [
                .webSearch, .examineImage, .detectObjects, .pointAtObject,
                .screenLocate { ScreenFixtures.capture() },
            ]
        )
        let fields = try encodedFields(config)
        guard let agent = object(fields, "agent"),
            case .array(let tools)? = agent["tools"]
        else {
            Issue.record("expected agent.tools on the wire")
            return
        }
        var kinds: [JSONValue] = []
        for tool in tools {
            guard case .object(let spec) = tool else {
                Issue.record("tool spec did not encode as an object")
                return
            }
            // Zero-config entries: the kind is the entire spec.
            #expect(spec.count == 1)
            if let kind = spec["kind"] { kinds.append(kind) }
        }
        #expect(
            kinds == [
                .string("web_search"),
                .string("examine_image"),
                .string("detect_objects"),
                .string("point_at_object"),
                // The capture slot is never advertised as a client tool; what
                // crosses the wire is the locator it asks the server to run.
                .string("screen_locate"),
            ]
        )
    }

}
