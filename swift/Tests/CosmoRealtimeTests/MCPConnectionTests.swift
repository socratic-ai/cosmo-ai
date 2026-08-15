import Foundation
import Testing
@testable import CosmoRealtime

/// In-memory transport: maps a method name to a canned JSON `result` string,
/// or an error to throw. Records the params it was called with.
final class FakeMCPTransport: MCPTransport, @unchecked Sendable {
    var responses: [String: String]
    var errors: [String: MCPError]
    private(set) var requests: [(method: String, params: String)] = []
    private(set) var notifications: [(method: String, params: String)] = []
    var closed = false
    init(responses: [String: String] = [:], errors: [String: MCPError] = [:]) {
        self.responses = responses
        self.errors = errors
    }
    func request(method: String, paramsJSON: String) async throws -> String {
        requests.append((method, paramsJSON))
        if let e = errors[method] { throw e }
        return responses[method] ?? "{}"
    }
    func notify(method: String, paramsJSON: String) async {
        notifications.append((method, paramsJSON))
    }
    func close() async { closed = true }
}

@Suite("MCP connection")
struct MCPConnectionTests {
    @Test func listToolsParsesNameDescriptionAndSchema() async throws {
        let result = #"{"tools":[{"name":"read","description":"Read a file","inputSchema":{"type":"object","properties":{"p":{"type":"string"}}}}]}"#
        let conn = MCPConnection(transport: FakeMCPTransport(responses: ["tools/list": result]), serverName: "fs")
        let tools = try await conn.listTools()
        #expect(tools.count == 1)
        #expect(tools[0].name == "read")
        #expect(tools[0].description == "Read a file")
        #expect(tools[0].inputSchemaJSON?.contains("\"type\":\"object\"") == true)
    }

    @Test func callToolMapsTextAndStructured() async throws {
        let result = #"{"content":[{"type":"text","text":"hello"}],"structuredContent":{"k":1}}"#
        let conn = MCPConnection(transport: FakeMCPTransport(responses: ["tools/call": result]), serverName: "fs")
        let r = try await conn.callTool(name: "read", argsJSON: "{}")
        #expect(r.isError == false)
        #expect(r.text == "hello")
        #expect(r.structuredJSON?.contains("\"k\":1") == true)
    }

    @Test func callToolFlagsIsError() async throws {
        let result = #"{"content":[{"type":"text","text":"boom"}],"isError":true}"#
        let conn = MCPConnection(transport: FakeMCPTransport(responses: ["tools/call": result]), serverName: "fs")
        let r = try await conn.callTool(name: "x", argsJSON: "{}")
        #expect(r.isError == true)
        #expect(r.text == "boom")
    }

    @Test func rpcErrorPropagates() async throws {
        let conn = MCPConnection(
            transport: FakeMCPTransport(errors: ["tools/list": .rpc("nope")]),
            serverName: "fs"
        )
        await #expect(throws: MCPError.self) { _ = try await conn.listTools() }
    }

    @Test func callToolEscapesNameInParams() async throws {
        let transport = FakeMCPTransport(responses: ["tools/call": #"{"content":[{"type":"text","text":"ok"}]}"#])
        let conn = MCPConnection(transport: transport, serverName: "fs")
        _ = try await conn.callTool(name: "weird\"name", argsJSON: "{}")
        let params = transport.requests.first { $0.method == "tools/call" }?.params ?? ""
        let obj = try JSONSerialization.jsonObject(with: Data(params.utf8)) as? [String: Any]
        #expect(obj?["name"] as? String == "weird\"name")
    }

    @Test func initializeSendsNotificationsInitialized() async throws {
        let transport = FakeMCPTransport()
        let conn = MCPConnection(transport: transport, serverName: "fs")
        try await conn.initialize()
        #expect(transport.notifications.count == 1)
        #expect(transport.notifications[0].method == "notifications/initialized")
    }

    @Test func listToolsThrowsOnWrongShape() async throws {
        let conn = MCPConnection(
            transport: FakeMCPTransport(responses: ["tools/list": #"{"nottools":"surprise"}"#]),
            serverName: "fs"
        )
        await #expect(throws: MCPError.self) { _ = try await conn.listTools() }
    }

    @Test func callToolThrowsOnMalformedResponse() async throws {
        let conn = MCPConnection(
            transport: FakeMCPTransport(responses: ["tools/call": "not json at all {"]),
            serverName: "fs"
        )
        await #expect(throws: MCPError.self) { _ = try await conn.callTool(name: "read", argsJSON: "{}") }
    }

    @Test func callToolDoesNotThrowWhenStructuredContentAbsent() async throws {
        // Verifies the pre-existing "key absent" branch: no structuredContent means
        // structuredJSON is nil without throwing. This task's new preview-logging line
        // (for the separate "present but not JSON-serializable" branch) has no automated
        // test — FakeMCPTransport can't hand back a non-serializable value like NaN
        // through a JSON string literal, and Self.log.warning isn't observable from here.
        let result = #"{"content":[{"type":"text","text":"ok"}]}"#
        let transport = FakeMCPTransport(responses: ["tools/call": result])
        let conn = MCPConnection(transport: transport, serverName: "fs")
        let r = try await conn.callTool(name: "x", argsJSON: "{}")
        #expect(r.isError == false)
        #expect(r.text == "ok")
        #expect(r.structuredJSON == nil)
    }
}
