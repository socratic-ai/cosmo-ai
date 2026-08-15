// Tests/CosmoRealtimeTests/MCPConfigTests.swift
import Foundation
import Testing
@testable import CosmoRealtime

@Suite("MCP config parsing")
struct MCPConfigTests {
    @Test func parsesStdioServer() throws {
        let json = #"{"mcpServers":{"fs":{"command":"npx","args":["-y","server-fs","/tmp"]}}}"#
        let (servers, skipped) = try parseMCPConfig(Data(json.utf8))
        #expect(skipped.isEmpty)
        #expect(servers == [McpStdioServer(name: "fs", command: "npx", args: ["-y", "server-fs", "/tmp"])])
    }

    @Test func skipsRemoteEntries() throws {
        let json = #"{"mcpServers":{"local":{"command":"npx","args":["x"]},"r1":{"url":"https://x/mcp"},"r2":{"type":"http","command":"ignored"}}}"#
        let (servers, skipped) = try parseMCPConfig(Data(json.utf8))
        #expect(servers.map(\.name) == ["local"])
        #expect(Set(skipped) == ["r1", "r2"])
    }

    @Test func rejectsMissingMcpServers() {
        #expect(throws: MCPConfigError.self) {
            _ = try parseMCPConfig(Data(#"{"servers":{}}"#.utf8))
        }
    }

    @Test func rejectsServerWithoutCommand() {
        #expect(throws: MCPConfigError.self) {
            _ = try parseMCPConfig(Data(#"{"mcpServers":{"bad":{"args":["x"]}}}"#.utf8))
        }
    }
}
