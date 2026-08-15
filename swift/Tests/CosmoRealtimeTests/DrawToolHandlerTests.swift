import Foundation
import Testing
@testable import CosmoRealtime

/// The renderer tools the SDK vends: the caller supplies one function of
/// request → outcome, and the SDK owns everything either side of it — the
/// declaration, the decode, and the reply the model reads.
@Suite("Renderer tool handlers")
@MainActor
struct DrawToolHandlerTests {

    private let boxArgs: [String: JSONValue] = [
        "box": .object([
            "x": .double(0.1), "y": .double(0.2),
            "width": .double(0.3), "height": .double(0.4),
        ]),
        "label": .string("the reset button"),
    ]

    private func handler(
        for tool: SessionConfig.Tool, named name: String
    ) throws -> ClientToolHandler {
        try #require(SessionConfig(tools: [tool]).clientToolHandlers()[name])
    }

    @Test("the declared tool always carries its handler")
    func toolCarriesItsHandler() throws {
        _ = try handler(
            for: .drawBox { _ in .shown },
            named: DrawBoxTool.name
        )
        _ = try handler(
            for: .drawPoint { _ in .shown },
            named: DrawPointTool.name
        )
    }

    @Test("the handler receives a decoded, clamped request")
    func handlerReceivesTypedRequest() async throws {
        var seen: DrawBoxRequest?
        let handler = try handler(
            for: .drawBox { request in seen = request; return .shown },
            named: DrawBoxTool.name
        )
        _ = try await handler(boxArgs)
        #expect(seen?.box.x == 0.1)
        #expect(seen?.label == "the reset button")
    }

    @Test("drawing reports shown")
    func shownReachesTheModel() async throws {
        let handler = try handler(
            for: .drawBox { _ in .shown },
            named: DrawBoxTool.name
        )
        let result = try await handler(boxArgs)
        #expect(result["shown"] == .bool(true))
        #expect(result["reason"] == nil)
    }

    @Test("refusing to draw tells the model why, so it can say something useful")
    func refusalCarriesItsReason() async throws {
        let handler = try handler(
            for: .drawBox { _ in
                .notShown("the camera is off — ask the user to turn it on")
            },
            named: DrawBoxTool.name
        )
        let result = try await handler(boxArgs)
        #expect(result["shown"] == .bool(false))
        #expect(result["reason"] == .string("the camera is off — ask the user to turn it on"))
    }

    @Test("malformed model arguments never reach the handler")
    func malformedArgumentsAreRejected() async throws {
        var called = false
        let handler = try handler(
            for: .drawBox { _ in called = true; return .shown },
            named: DrawBoxTool.name
        )
        await #expect(throws: (any Error).self) {
            _ = try await handler(["box": .string("over there")])
        }
        #expect(!called)
    }

    @Test("the point renderer follows the same contract")
    func pointRendererMatches() async throws {
        var seen: DrawPointRequest?
        let handler = try handler(
            for: .drawPoint { request in
                seen = request
                return .notShown("no preview is visible")
            },
            named: DrawPointTool.name
        )
        let result = try await handler([
            "point": .object(["x": .double(0.5), "y": .double(0.25)]),
        ])
        #expect(seen?.point.y == 0.25)
        #expect(result["shown"] == .bool(false))
        #expect(result["reason"] == .string("no preview is visible"))
    }

    @Test("a caller's own tool cannot claim the SDK's prefix")
    func reservedPrefixIsRejected() throws {
        let squatter = SessionConfig.Tool.client(
            name: "cosmo_sdk_draw_everything",
            description: "Impersonates an SDK tool.",
            parameters: [:],
            handler: { _ in [:] }
        )
        #expect(throws: RealtimeSessionError.self) {
            try SessionConfig(tools: [squatter]).assertNoReservedToolNames()
        }
    }

    @Test("the SDK's own tools pass the same check — by construction, not by name")
    func sdkToolsAreAllowed() throws {
        let config = SessionConfig(tools: [
            .drawBox { _ in .shown },
            .drawPoint { _ in .shown },
        ])
        try config.assertNoReservedToolNames()
    }

    @Test("a caller's tool outside the prefix is untouched")
    func ordinaryNamesAreUnaffected() throws {
        let mine = SessionConfig.Tool.client(
            name: "draw_box",
            description: "My own renderer, natural name still free.",
            parameters: [:],
            handler: { _ in [:] }
        )
        try SessionConfig(tools: [mine]).assertNoReservedToolNames()
    }

    @Test("a background client tool cannot claim the prefix either")
    func reservedPrefixCoversBackgroundTools() throws {
        // Same wire shape as .client, so the same rule has to reach it.
        let squatter = SessionConfig.Tool.backgroundClient(
            name: "cosmo_sdk_draw_everything",
            description: "Impersonates an SDK tool.",
            parameters: [:],
            handler: { _, _ in }
        )
        #expect(throws: RealtimeSessionError.self) {
            try SessionConfig(tools: [squatter]).assertNoReservedToolNames()
        }
    }

    @Test("every tool case equals itself, including the ones the SDK ships")
    func toolEqualityIsReflexive() {
        // A case missing from `Tool.==` compares unequal to itself, which no
        // handler or wire test can see.
        let tools: [SessionConfig.Tool] = [
            .drawBox { _ in .shown },
            .drawPoint { _ in .shown },
            .client(name: "t", description: "d", parameters: [:], handler: { _ in [:] }),
            .backgroundClient(name: "b", description: "d", parameters: [:], handler: { _, _ in }),
            .webSearch, .examineImage, .detectObjects, .pointAtObject,
        ]
        for tool in tools {
            #expect(tool == tool, "\(tool.name) is not equal to itself")
        }
    }

    @Test("a session's draw tools are findable in the list that holds them")
    func sdkToolsSurviveCollectionLookup() {
        // What an unequal-to-itself case actually costs a consumer.
        let box = SessionConfig.Tool.drawBox { _ in .shown }
        let mine = SessionConfig.Tool.client(
            name: "my_tool", description: "d", parameters: [:], handler: { _ in [:] }
        )
        let tools: [SessionConfig.Tool] = [mine, box]
        #expect(tools.contains(box))
        #expect(tools.firstIndex(of: box) == 1)
    }

    @Test("two configs declaring the same renderer are equal")
    func distinctConfigsWithTheSameRendererCompareEqual() {
        // Separately built arrays: comparing one config to itself passes on
        // shared array storage even when the element comparison is broken.
        let left = SessionConfig(tools: [.drawBox { _ in .shown }])
        let right = SessionConfig(tools: [.drawBox { _ in .shown }])
        #expect(left == right)
        #expect(left != SessionConfig(tools: [.drawPoint { _ in .shown }]))
    }

    @Test("an SDK tool's exact name cannot be taken by a hand-built spec")
    func exactSdkNamesAreNotAnEscapeHatch() throws {
        // The dangerous case an allow-list would have let through: same name,
        // someone else's schema and handler, silently replacing the SDK's.
        for squatter in [
            SessionConfig.Tool.client(
                name: DrawBoxTool.name, description: "Not the SDK's.",
                parameters: [:], handler: { _ in [:] }
            ),
            SessionConfig.Tool.backgroundClient(
                name: DrawPointTool.name, description: "Not the SDK's.",
                parameters: [:], handler: { _, _ in }
            ),
        ] {
            #expect(throws: RealtimeSessionError.self) {
                try SessionConfig(tools: [squatter]).assertNoReservedToolNames()
            }
        }
    }
}
