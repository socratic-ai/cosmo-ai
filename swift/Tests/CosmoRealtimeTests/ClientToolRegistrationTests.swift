import Foundation
import Testing
@testable import CosmoRealtime

/// The advertise-vs-register matrix for client tools. A tool can be:
///   - advertised AND RPC-handled (a normal ``AgentTool.client`` with a handler),
///   - advertised but NOT handled (server-orchestrated, e.g. ``mouse_click`` → handler nil),
///   - RPC-handled but NOT advertised (the grounding RPCs — passed via ``rpcHandlers``).
///
/// The third case is the one a naive "handlers = declared tools" mapping silently drops,
/// breaking the server-orchestrated grounding flow on-device. These tests pin that the
/// register-only ``rpcHandlers`` path reaches the transport's RPC registration while staying
/// off the advertised wire config.
@Suite("Client-tool registration")
struct ClientToolRegistrationTests {

    @Test("rpcHandlers register without advertising; handler tools advertise + register")
    func advertiseRegisterMatrix() async throws {
        let transport = FakeSessionTransport()
        let session = RealtimeSession(transport: transport)

        let config = SessionConfig(
            tools: [
                // advertised AND RPC-handled
                .client(name: "handled_tool", description: "runs locally",
                        parameters: ["type": .string("object")],
                        handler: { _ in [:] }),
                // advertised but NOT self-handled (server-orchestrated)
                .client(name: "mouse_click", description: "server-orchestrated",
                        parameters: ["type": .string("object")], handler: nil),
                // advertised server tool (typed opt-in)
                .webSearch,
            ]
        )
        try await session._start(
            config: config,
            rpcHandlers: [
                // RPC-handled but NEVER advertised
                "grounding_capture": { _ in [:] },
                "grounding_click": { _ in [:] },
            ]
        )

        // Registered = handler-bearing client tools ∪ rpcHandlers. `mouse_click`
        // (handler nil) and the server tool register nothing.
        let registered = await transport.registeredToolHandlers
        #expect(Set(registered.keys) == ["handled_tool", "grounding_capture", "grounding_click"])

        // Advertised (on the wire) = every client/server tool; the register-only
        // grounding RPCs are absent.
        let frame = try #require(await transport.sent.first)
        let advertised = Self.advertisedToolNames(frame)
        // Name-bearing specs are the client tools; the typed server opt-in
        // carries only its kind (zero-config), so it has no name to advertise.
        #expect(advertised == ["handled_tool", "mouse_click"])
        #expect(Self.advertisedToolKinds(frame).contains("web_search"))
    }

    @Test("no rpcHandlers is the default and registers nothing extra")
    func noRpcHandlersRegistersNothingExtra() async throws {
        let transport = FakeSessionTransport()
        let session = RealtimeSession(transport: transport)
        try await session._start(config: SessionConfig())

        let registered = await transport.registeredToolHandlers
        #expect(registered.isEmpty)
    }

    /// Pull `agent.tools[].name` out of the serialized ``session-config`` frame
    /// without depending on the generated wire types.
    private static func advertisedToolKinds(_ frame: Data) -> Set<String> {
        guard
            let object = try? JSONSerialization.jsonObject(with: frame) as? [String: Any],
            let agent = object["agent"] as? [String: Any],
            let tools = agent["tools"] as? [[String: Any]]
        else { return [] }
        return Set(tools.compactMap { $0["kind"] as? String })
    }

    private static func advertisedToolNames(_ frame: Data) -> Set<String> {
        guard
            let object = try? JSONSerialization.jsonObject(with: frame) as? [String: Any],
            let agent = object["agent"] as? [String: Any],
            let tools = agent["tools"] as? [[String: Any]]
        else { return [] }
        return Set(tools.compactMap { $0["name"] as? String })
    }
}
