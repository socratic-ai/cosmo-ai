import Foundation
import Testing
@testable import CosmoRealtime

@Suite("MCP registry")
struct McpRegistryTests {
    private func factory(list: [String: String], call: [String: String] = [:]) -> MCPTransportFactory {
        { server in
            FakeMCPTransport(responses: [
                "tools/list": list[server.name] ?? #"{"tools":[]}"#,
                "tools/call": call[server.name] ?? #"{"content":[{"type":"text","text":"ok"}]}"#,
            ])
        }
    }

    @Test func connectBuildsNamespacedTools() async throws {
        let reg = McpRegistry(servers: [McpStdioServer(name: "fs", command: "x")])
        let connected = try await reg.connect(
            reservedNames: [],
            transportFactory: factory(list: ["fs": #"{"tools":[{"name":"read","inputSchema":{"type":"object"}}]}"#])
        )
        let names = await connected.tools.compactMap { tool -> String? in
            if case let .client(name, _, _, _) = tool { return name }
            return nil
        }
        #expect(names == ["mcp__fs__read"])
    }

    @Test func connectSkipsFailedServerKeepsOthers() async throws {
        let reg = McpRegistry(servers: [McpStdioServer(name: "ok", command: "x"), McpStdioServer(name: "bad", command: "y")])
        let f: MCPTransportFactory = { server in
            if server.name == "bad" {
                return FakeMCPTransport(errors: ["initialize": .rpc("nope")])
            }
            return FakeMCPTransport(responses: ["tools/list": #"{"tools":[{"name":"t","inputSchema":{"type":"object"}}]}"#])
        }
        let connected = try await reg.connect(reservedNames: [], transportFactory: f)
        #expect(await connected.tools.count == 1)
    }

    @Test func acloseIsIdempotent() async throws {
        let reg = McpRegistry(servers: [McpStdioServer(name: "fs", command: "x")])
        let connected = try await reg.connect(
            reservedNames: [],
            transportFactory: factory(list: ["fs": #"{"tools":[]}"#])
        )
        await connected.aclose()
        await connected.aclose()
        #expect(Bool(true))
    }

    @Test func reservedNamesForceCollision() async throws {
        let reg = McpRegistry(servers: [McpStdioServer(name: "fs", command: "x")])
        let connected = try await reg.connect(
            reservedNames: ["mcp__fs__read"],
            transportFactory: factory(list: ["fs": #"{"tools":[{"name":"read","inputSchema":{"type":"object"}}]}"#])
        )
        #expect(await connected.tools.isEmpty)
        #expect(await connected.skipped == [SkippedTool(server: "fs", tool: "read", reason: "name_collision")])
    }
}
