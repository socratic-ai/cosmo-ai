import Foundation
import Testing
@testable import CosmoRealtime

private struct WeatherArgs: Decodable, Sendable {
    let city: String
    let unit: Unit?
    enum Unit: String, Decodable, Sendable { case c, f }
}

private struct OrderArgs: Decodable, Sendable {
    struct Item: Decodable, Sendable { let sku: String }
    let items: [Item]
}

private let weatherInput = ToolSchema.object(
    properties: [
        "city": .string(description: "City name"),
        "unit": .enum(["c", "f"]),
    ],
    required: ["city"]
)

private func weatherTool() throws -> AgentTool {
    try AgentTool.define(
        name: "get_weather",
        description: "Current weather for a city.",
        input: weatherInput
    ) { (args: WeatherArgs) in
        [
            "city": .string(args.city),
            "unit": .string((args.unit ?? .c).rawValue),
        ]
    }
}

private func clientHandler(_ tool: AgentTool) -> ClientToolHandler? {
    if case let .client(_, _, _, handler) = tool { return handler }
    return nil
}

@Suite("AgentTool.define builder")
struct ToolBuilderTests {

    // MARK: - Lowering

    @Test("define lowers to the equivalent hand-written client spec")
    func lowersToHandWrittenSpec() throws {
        let defined = try weatherTool()
        // Ground truth written by hand — not the builder's own output — so the
        // equality pins that define lowers to exactly this declaration
        // (Tool.== ignores handlers, matching the wire).
        let handWritten = AgentTool.client(
            name: "get_weather",
            description: "Current weather for a city.",
            parameters: [
                "type": .string("object"),
                "properties": .object([
                    "city": .object([
                        "type": .string("string"),
                        "description": .string("City name"),
                    ]),
                    "unit": .object([
                        "type": .string("string"),
                        "enum": .array([.string("c"), .string("f")]),
                    ]),
                ]),
                "required": .array([.string("city")]),
            ]
        )
        #expect(defined == handWritten)
    }

    @Test("defineBackground lowers to the equivalent backgroundClient spec")
    func backgroundLowersToBackgroundClient() throws {
        let defined = try AgentTool.defineBackground(
            name: "export_weather",
            description: "Slow weather export.",
            input: weatherInput
        ) { (_: WeatherArgs, job: ClientToolJob) in
            await job.ack()
        }
        let handWritten = AgentTool.backgroundClient(
            name: "export_weather",
            description: "Slow weather export.",
            parameters: [
                "type": .string("object"),
                "properties": .object([
                    "city": .object([
                        "type": .string("string"),
                        "description": .string("City name"),
                    ]),
                    "unit": .object([
                        "type": .string("string"),
                        "enum": .array([.string("c"), .string("f")]),
                    ]),
                ]),
                "required": .array([.string("city")]),
            ],
            handler: { _, _ in }
        )
        #expect(defined == handWritten)
    }

    @Test("schema attributes lower to the dialect keys")
    func schemaAttributesLower() {
        let lowered = ToolSchema.object(
            properties: [
                "count": .integer(minimum: 0, maximum: 10, default: 1),
                "price": .number(minimum: 0.5),
                "active": .boolean(default: true),
                "tags": .array(items: .string(maxLength: 16)),
                "note": .anyOf([.string(minLength: 2), .null]),
            ],
            description: "Attributes."
        ).lowered()
        #expect(lowered == [
            "type": .string("object"),
            "description": .string("Attributes."),
            "properties": .object([
                "count": .object([
                    "type": .string("integer"), "minimum": .int(0),
                    "maximum": .int(10), "default": .int(1),
                ]),
                "price": .object(["type": .string("number"), "minimum": .double(0.5)]),
                "active": .object(["type": .string("boolean"), "default": .bool(true)]),
                "tags": .object([
                    "type": .string("array"),
                    "items": .object(["type": .string("string"), "maxLength": .int(16)]),
                ]),
                "note": .object([
                    "anyOf": .array([
                        .object(["type": .string("string"), "minLength": .int(2)]),
                        .object(["type": .string("null")]),
                    ])
                ]),
            ]),
        ])
    }

    // MARK: - Typed decoding

    @Test("the handler receives decoded typed args")
    func handlerReceivesTypedArgs() async throws {
        let handler = try #require(clientHandler(try weatherTool()))
        let result = try await handler(["city": .string("Paris")])
        // unit omitted decodes as nil; the schema default is model guidance
        // only, so the fallback happens in handler code.
        #expect(result == ["city": .string("Paris"), "unit": .string("c")])
    }

    @Test("surplus arguments are ignored, not rejected")
    func surplusArgumentsIgnored() async throws {
        let handler = try #require(clientHandler(try weatherTool()))
        let result = try await handler(["city": .string("Paris"), "surplus": .bool(true)])
        #expect(result == ["city": .string("Paris"), "unit": .string("c")])
    }

    // MARK: - Decode-failure error shape

    @Test("a missing required field raises the normalized INVALID_INPUT shape")
    func missingFieldNormalizedError() async throws {
        let handler = try #require(clientHandler(try weatherTool()))
        await #expect(throws: ToolInputValidationError.self) {
            _ = try await handler([:])
        }
        do {
            _ = try await handler([:])
        } catch let error as ToolInputValidationError {
            let lines = error.message.split(separator: "\n").map(String.init)
            #expect(lines.first == "INVALID_INPUT: get_weather rejected parameters:")
            #expect(lines.last == "Fix the input and retry.")
            #expect(lines.contains("- city: required"))
            #expect(error.issues == [.init(path: "city", code: "key_not_found", constraint: "required")])
        }
    }

    @Test("an invalid enum value never echoes the submitted value")
    func invalidEnumValueNotEchoed() async throws {
        let handler = try #require(clientHandler(try weatherTool()))
        do {
            _ = try await handler([
                "city": .string("Paris"), "unit": .string("kelvin-secret-value"),
            ])
            Issue.record("expected a validation error")
        } catch let error as ToolInputValidationError {
            #expect(!error.message.contains("kelvin-secret-value"))
            #expect(error.message.contains("- unit: not an allowed value"))
        }
    }

    @Test("a type mismatch names the expected shape, not the value")
    func typeMismatchNamesExpectedShape() async throws {
        let handler = try #require(clientHandler(try weatherTool()))
        do {
            _ = try await handler(["city": .int(5)])
            Issue.record("expected a validation error")
        } catch let error as ToolInputValidationError {
            #expect(error.message.contains("- city: expected a string"))
        }
    }

    @Test("nested paths are dotted and indexed")
    func nestedPathsDottedAndIndexed() async throws {
        let tool = try AgentTool.define(
            name: "place_order",
            description: "Place an order.",
            input: .object(
                properties: [
                    "items": .array(items: .object(
                        properties: ["sku": .string()], required: ["sku"]
                    ))
                ],
                required: ["items"]
            )
        ) { (_: OrderArgs) in [:] }
        let handler = try #require(clientHandler(tool))
        do {
            _ = try await handler([
                "items": .array([.object(["sku": .string("ok")]), .object([:])])
            ])
            Issue.record("expected a validation error")
        } catch let error as ToolInputValidationError {
            #expect(error.message.contains("- items[1].sku: required"))
        }
    }

    @Test("issue lines cap at five and the message stays under 1 KiB")
    func issueLinesCappedAndBounded() {
        let issues = (0..<7).map {
            ToolInputValidationError.Issue(path: "field\($0)", code: "key_not_found", constraint: "required")
        }
        let message = ToolInputValidationError.formatMessage(
            toolName: "wide_tool", issues: issues
        )
        #expect(message.components(separatedBy: "\n- ").count - 1 == 6)  // 5 issues + overflow
        #expect(message.contains("- … and 2 more"))
        #expect(message.utf8.count <= 1024)

        let longPath = String(repeating: "p", count: 400)
        let longIssues = (0..<5).map {
            ToolInputValidationError.Issue(path: "\(longPath)\($0)", code: "key_not_found", constraint: "required")
        }
        let bounded = ToolInputValidationError.formatMessage(
            toolName: "wide_tool", issues: longIssues
        )
        #expect(bounded.utf8.count <= 1024)
        #expect(bounded.contains("and"))
    }

    @Test("the dispatch layer turns a decode failure into the error envelope")
    func decodeFailureBecomesErrorEnvelope() async throws {
        let handler = try #require(clientHandler(try weatherTool()))
        let reply = await invokeClientToolHandler(
            handler, tool: "get_weather", payload: #"{"unit":"x"}"#,
            hooks: nil, sessionId: nil
        )
        guard
            case .object(let fields)? = try? JSONDecoder().decode(
                JSONValue.self, from: Data(reply.utf8)
            )
        else {
            Issue.record("reply envelope was not a JSON object")
            return
        }
        #expect(fields["ok"] == .bool(false))
        guard case .string(let message)? = fields["error"] else {
            Issue.record("expected an error string")
            return
        }
        #expect(message.hasPrefix("INVALID_INPUT: get_weather rejected parameters:"))
        #expect(!message.contains("\"x\""))
    }

    // MARK: - Background variant

    @Test("a background handler receives decoded args and the job")
    func backgroundHandlerReceivesArgsAndJob() async throws {
        let seenCity = CaptureBox<String>()
        let tool = try AgentTool.defineBackground(
            name: "export_weather",
            description: "Slow weather export.",
            input: weatherInput
        ) { (args: WeatherArgs, job: ClientToolJob) in
            await seenCity.set(args.city)
            await job.ack()
        }
        guard case let .backgroundClient(_, _, _, handler) = tool else {
            Issue.record("expected a backgroundClient spec")
            return
        }
        let sink = ClientToolJobSink(deliver: { _ in }, isOpen: { true })
        let job = ClientToolJob(
            jobId: "j1", toolName: "export_weather", sink: sink,
            hooks: nil, sessionId: nil, arguments: [:]
        )
        try await handler(["city": .string("Paris")], job)
        #expect(await seenCity.value == "Paris")

        await #expect(throws: ToolInputValidationError.self) {
            try await handler([:], job)
        }
    }

    // MARK: - Construction-time rejection

    @Test("a bad tool name is rejected at construction")
    func badNameRejected() {
        #expect(throws: ToolDefinitionError.self) {
            _ = try AgentTool.define(
                name: "GetWeather", description: "Camel case.", input: weatherInput
            ) { (_: WeatherArgs) in [:] }
        }
    }

    @Test("a missing description is rejected at construction")
    func missingDescriptionRejected() {
        #expect(throws: ToolDefinitionError.self) {
            _ = try AgentTool.define(
                name: "get_weather", description: "", input: weatherInput
            ) { (_: WeatherArgs) in [:] }
        }
    }

    @Test("an overlong description reports actual and max lengths")
    func overlongDescriptionReportsActualAndMax() {
        do {
            _ = try AgentTool.define(
                name: "get_weather",
                description: String(repeating: "x", count: 2049),
                input: weatherInput
            ) { (_: WeatherArgs) in [:] }
            Issue.record("expected a construction error")
        } catch let error as ToolDefinitionError {
            #expect(error.message.contains("2049"))
            #expect(error.message.contains("2048"))
        } catch {
            Issue.record("expected ToolDefinitionError, got \(error)")
        }
    }

    @Test("a control character in the description is rejected")
    func controlCharacterDescriptionRejected() {
        #expect(throws: ToolDefinitionError.self) {
            _ = try AgentTool.define(
                name: "get_weather", description: "bad\u{07}text", input: weatherInput
            ) { (_: WeatherArgs) in [:] }
        }
    }

    @Test("a schema past the depth cap is rejected with the vector code")
    func depthCapRejected() {
        var schema = ToolSchema.string()
        for _ in 0..<6 { schema = .object(properties: ["p": schema]) }
        do {
            _ = try AgentTool.define(
                name: "deep_tool", description: "Too deep.", input: schema
            ) { (_: WeatherArgs) in [:] }
            Issue.record("expected a schema error")
        } catch let error as ToolSchemaError {
            #expect(error.code == "max_depth_exceeded")
        } catch {
            Issue.record("expected ToolSchemaError, got \(error)")
        }

        var atLimit = ToolSchema.string()
        for _ in 0..<5 { atLimit = .object(properties: ["p": atLimit]) }
        #expect(throws: Never.self) {
            _ = try AgentTool.define(
                name: "deep_tool", description: "At the limit.", input: atLimit
            ) { (_: WeatherArgs) in [:] }
        }
    }

    @Test("a schema past the global property cap is rejected with the vector code")
    func propertyCapRejected() {
        let wide = ToolSchema.object(
            properties: Dictionary(
                uniqueKeysWithValues: (0..<65).map { ("p\($0)", ToolSchema.string()) }
            )
        )
        do {
            _ = try AgentTool.define(
                name: "wide_tool", description: "Too wide.", input: wide
            ) { (_: WeatherArgs) in [:] }
            Issue.record("expected a schema error")
        } catch let error as ToolSchemaError {
            #expect(error.code == "max_properties_exceeded")
        } catch {
            Issue.record("expected ToolSchemaError, got \(error)")
        }
    }

    // MARK: - Consistency check

    @Test("the consistency check passes for an agreeing schema/type pair")
    func consistencyCheckPasses() throws {
        try ToolSchemaConsistencyCheck.verify(input: weatherInput, decodesInto: WeatherArgs.self)
    }

    @Test("the consistency check catches a schema/type type mismatch")
    func consistencyCheckCatchesTypeMismatch() {
        struct BadArgs: Decodable { let city: Int }
        #expect(throws: ToolSchemaConsistencyCheck.Failure.self) {
            try ToolSchemaConsistencyCheck.verify(input: weatherInput, decodesInto: BadArgs.self)
        }
    }

    @Test("the required-only sample catches a schema-optional but type-required field")
    func consistencyCheckCatchesOptionalityMismatch() {
        struct StrictArgs: Decodable {
            let city: String
            let unit: String
        }
        #expect(throws: ToolSchemaConsistencyCheck.Failure.self) {
            try ToolSchemaConsistencyCheck.verify(input: weatherInput, decodesInto: StrictArgs.self)
        }
    }

    @Test("an items-less array samples empty; a typed array samples one element")
    func arraySampleValuePinned() {
        #expect(ToolSchema.array().sampleValue(includeOptionalProperties: true) == .array([]))
        if case .array(let elements) = ToolSchema.array(items: .string())
            .sampleValue(includeOptionalProperties: true) {
            #expect(elements.count == 1)
        } else {
            Issue.record("typed array sample is not an array")
        }
    }
}
