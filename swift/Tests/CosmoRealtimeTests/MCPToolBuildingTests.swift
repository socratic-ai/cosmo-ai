import Foundation
import Testing
@testable import CosmoRealtime

@Suite("MCP tool building")
struct MCPToolBuildingTests {
    private func info(_ name: String, schema: String? = #"{"type":"object"}"#) -> MCPToolInfo {
        MCPToolInfo(name: name, description: "d", inputSchemaJSON: schema)
    }
    private func server(
        _ name: String,
        _ tools: [MCPToolInfo],
        call: @escaping MCPCall = { _, _ in MCPCallResult(isError: false, text: "ok", structuredJSON: nil) }
    ) -> BuiltServer {
        BuiltServer(name: name, tools: tools, call: call)
    }

    @Test func namespacesAndNormalizes() {
        #expect(exposedName(server: "gh", tool: "list issues") == "mcp__gh__list_issues")
        #expect(exposedName(server: "a.b", tool: "x/y") == "mcp__a_b__x_y")
    }

    @Test func normalizeSchemaAcceptsObjectRejectsOthers() {
        #expect(normalizedSchema(#"{"type":"object"}"#) != nil)
        #expect(normalizedSchema(#"{"type":"array"}"#) == nil)
        #expect(normalizedSchema(nil) == nil)
    }

    @Test func normalizeSchemaStripsKeysOutsideBackendDialect() {
        // server-everything (and most MCP servers) emit $schema/additionalProperties/
        // title, which the realtime backend's client-declared gate rejects on the
        // first unknown key. They must be stripped, recursively, before declaration.
        let raw = #"""
        {
          "$schema": "http://json-schema.org/draft-07/schema#",
          "type": "object",
          "title": "Echo",
          "additionalProperties": false,
          "properties": {
            "message": {
              "type": "string",
              "description": "Message to echo",
              "additionalProperties": false
            },
            "tags": {
              "type": "array",
              "items": {"type": "string", "title": "Tag"}
            }
          },
          "required": ["message"]
        }
        """#
        guard let schema = normalizedSchema(raw) else {
            Issue.record("expected a sanitized schema"); return
        }
        #expect(schema["$schema"] == nil)
        #expect(schema["title"] == nil)
        #expect(schema["additionalProperties"] == nil)
        #expect(schema["type"] == .string("object"))
        #expect(schema["required"] == .array([.string("message")]))
        guard case let .object(props) = schema["properties"],
              case let .object(message) = props["message"],
              case let .object(tags) = props["tags"],
              case let .object(items) = tags["items"]
        else {
            Issue.record("expected nested property schemas"); return
        }
        #expect(message["additionalProperties"] == nil)
        #expect(message["description"] == .string("Message to echo"))
        #expect(items["title"] == nil)
        #expect(items["type"] == .string("string"))
    }

    @Test func buildsBasicClientTool() {
        let (tools, skipped) = buildMCPTools([server("fs", [info("read")])], reservedNames: [])
        #expect(skipped.isEmpty)
        #expect(tools.count == 1)
        guard case let .client(name, _, parameters, handler) = tools[0] else {
            Issue.record("expected .client"); return
        }
        #expect(name == "mcp__fs__read")
        #expect(parameters["type"] == .string("object"))
        #expect(handler != nil)
    }

    @Test func handlerProxiesAndMapsResult() async throws {
        let srv = server("fs", [info("read")], call: { original, argsJSON in
            #expect(original == "read")
            #expect(argsJSON.contains("\"p\""))
            return MCPCallResult(isError: false, text: "file-body", structuredJSON: nil)
        })
        let (tools, _) = buildMCPTools([srv], reservedNames: [])
        guard case let .client(_, _, _, handler) = tools[0], let handler else {
            Issue.record("no handler"); return
        }
        let out = try await handler(["p": .string("x")])
        #expect(out["text"] == .string("file-body"))
    }

    @Test func handlerThrowsOnIsError() async throws {
        let srv = server("fs", [info("read")], call: { _, _ in
            MCPCallResult(isError: true, text: "boom", structuredJSON: nil)
        })
        let (tools, _) = buildMCPTools([srv], reservedNames: [])
        guard case let .client(_, _, _, handler) = tools[0], let handler else {
            Issue.record("no handler"); return
        }
        await #expect(throws: MCPToolError.self) { _ = try await handler([:]) }
    }

    @Test func mapResultPrefersStructured() throws {
        let out = try mcpResultObject(from: MCPCallResult(isError: false, text: "hi", structuredJSON: #"{"k":1}"#))
        #expect(out["k"] == .int(1))
    }

    @Test func skipsInvalidSchema() {
        let (tools, skipped) = buildMCPTools([server("fs", [info("bad", schema: #"{"type":"array"}"#)])], reservedNames: [])
        #expect(tools.isEmpty)
        #expect(skipped == [SkippedTool(server: "fs", tool: "bad", reason: "invalid_schema")])
    }

    @Test func skipsCollisionWithReservedAndWithin() {
        let (tools, skipped) = buildMCPTools([server("fs", [info("read"), info("read")])], reservedNames: ["mcp__fs__read"])
        #expect(tools.isEmpty)
        #expect(skipped.count == 2)
        #expect(skipped.allSatisfy { $0.reason == "name_collision" })
    }

    @Test func skipsNameOverflow() {
        let long = String(repeating: "x", count: 70)
        let (tools, skipped) = buildMCPTools([server("fs", [info(long)])], reservedNames: [])
        #expect(tools.isEmpty)
        #expect(skipped == [SkippedTool(server: "fs", tool: long, reason: "name_overflow")])
    }

    @Test func enforcesTotalCap() {
        let five = (0..<5).map { info("t\($0)") }
        let reserved = Set((0..<62).map { "r\($0)" })
        let (tools, skipped) = buildMCPTools([server("s", five)], reservedNames: reserved)
        #expect(tools.count == 2)
        #expect(skipped.count == 3)
        #expect(skipped.allSatisfy { $0.reason == "count_overflow" })
    }

    @Test func skipsIntraSetCollision() {
        // No reserved names: the first "read" is ACCEPTED, the second "read"
        // collides with the just-accepted peer (the "each other" branch).
        let (tools, skipped) = buildMCPTools([server("fs", [info("read"), info("read")])], reservedNames: [])
        #expect(tools.count == 1)
        if case let .client(name, _, _, _) = tools[0] { #expect(name == "mcp__fs__read") } else { Issue.record("expected .client") }
        #expect(skipped == [SkippedTool(server: "fs", tool: "read", reason: "name_collision")])
    }
}
