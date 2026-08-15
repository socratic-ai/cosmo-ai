import Foundation
import Testing
@testable import CosmoRealtime

@Suite("MCP process transport", .enabled(if: ProcessInfo.processInfo.environment["COSMO_MCP_PROCESS_TESTS"] == "1"))
struct MCPProcessTransportTests {
    /// A 6-line shell "MCP server" that answers any request id with a fixed
    /// tools/list-shaped result, proving framing + id correlation end to end.
    @Test func roundTripsOverStdio() async throws {
        let script = #"""
        while IFS= read -r line; do
          id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
          printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[]}}\n' "$id"
        done
        """#
        let server = McpStdioServer(name: "echo", command: "/bin/sh", args: ["-c", script])
        let transport = try MCPProcessTransport(server: server)
        let result = try await transport.request(method: "tools/list", paramsJSON: "{}")
        #expect(result.contains("\"tools\""))
        await transport.close()
    }

    @Test func doubleCloseIsSafe() async throws {
        let server = McpStdioServer(name: "echo", command: "/bin/sh", args: ["-c", "while IFS= read -r line; do :; done"])
        let transport = try MCPProcessTransport(server: server)
        await transport.close()
        await transport.close()
        // reaching here means the second close() did not crash
    }

    @Test func requestAfterCloseThrows() async throws {
        let server = McpStdioServer(name: "echo", command: "/bin/sh", args: ["-c", "while IFS= read -r line; do :; done"])
        let transport = try MCPProcessTransport(server: server)
        await transport.close()
        await #expect(throws: MCPError.self) {
            _ = try await transport.request(method: "tools/list", paramsJSON: "{}")
        }
    }

    @Test func inheritsOnlyTheMCPStandardWhitelist() async throws {
        setenv("COSMO_TEST_UNWHITELISTED_SECRET", "leaked", 1)
        defer { unsetenv("COSMO_TEST_UNWHITELISTED_SECRET") }
        let script = #"""
        while IFS= read -r line; do
          id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
          printf '{"jsonrpc":"2.0","id":%s,"result":{"home":"%s","secret":"%s"}}\n' \
            "$id" "${HOME:-}" "${COSMO_TEST_UNWHITELISTED_SECRET:-}"
        done
        """#
        let server = McpStdioServer(name: "envtest", command: "/bin/sh", args: ["-c", script])
        let transport = try MCPProcessTransport(server: server)
        let result = try await transport.request(method: "ping", paramsJSON: "{}")
        // HOME should be present and set (JSONSerialization escapes `/` as `\/`)
        #expect(result.contains(#""home":""#) && !result.contains(#""home":"""#))
        // Secret should be empty (not "leaked")
        #expect(result.contains(#""secret":"""#))
        await transport.close()
    }

    @Test func overlaysServerEnvOnTheWhitelist() async throws {
        let script = #"""
        while IFS= read -r line; do
          id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
          printf '{"jsonrpc":"2.0","id":%s,"result":{"foo":"%s","home_set":%s}}\n' \
            "$id" "${FOO:-}" "$([ -n "${HOME:-}" ] && echo true || echo false)"
        done
        """#
        let server = McpStdioServer(name: "envtest", command: "/bin/sh", args: ["-c", script], env: ["FOO": "bar"])
        let transport = try MCPProcessTransport(server: server)
        let result = try await transport.request(method: "ping", paramsJSON: "{}")
        #expect(result.contains(#""foo":"bar""#))
        #expect(result.contains(#""home_set":true"#))
        await transport.close()
    }

    @Test func requestTimesOutWhenServerNeverReplies() async throws {
        let server = McpStdioServer(name: "silent", command: "/bin/sh", args: ["-c", "while IFS= read -r line; do :; done"])
        let transport = try MCPProcessTransport(server: server, requestTimeout: 0.2)
        await #expect(throws: MCPError.self) {
            _ = try await transport.request(method: "tools/list", paramsJSON: "{}")
        }
        await transport.close()
    }

    @Test func stdoutBufferOverflowFailsPendingRequests() async throws {
        let server = McpStdioServer(name: "flood", command: "/bin/sh", args: ["-c", "yes x | tr -d '\n'"])
        let transport = try MCPProcessTransport(server: server, maxLineBufferBytes: 1024)
        await #expect(throws: MCPError.self) {
            _ = try await transport.request(method: "tools/list", paramsJSON: "{}")
        }
        await transport.close()
    }

    /// The complete JSON-RPC line and the bound-exceeding padding are built
    /// into one string and written with a single printf — one write()
    /// syscall — so they land in the same read()/availableData() chunk on
    /// the parent side. This is what actually exercises "drain complete
    /// lines before checking the bound," unlike two chunks arriving
    /// separately (which would pass under the old buggy ordering too).
    @Test func stdoutBufferDeliversCompleteLineEvenWhenChunkExceedsBound() async throws {
        let script = #"""
        IFS= read -r line
        id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
        resp=$(printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[]}}' "$id")
        padding=$(printf 'x%.0s' $(seq 1 1000))
        printf '%s\n%s' "$resp" "$padding"
        """#
        let server = McpStdioServer(name: "echo-then-flood", command: "/bin/sh", args: ["-c", script])
        let transport = try MCPProcessTransport(server: server, maxLineBufferBytes: 1024)
        let result = try await transport.request(method: "tools/list", paramsJSON: "{}")
        #expect(result.contains("\"tools\""))
        await transport.close()
    }
}

@Suite("MCP live validation", .enabled(if: ProcessInfo.processInfo.environment["COSMO_MCP_LIVE"] == "1"))
struct MCPLiveTests {
    @Test func serverEverythingHandshakeAndEcho() async throws {
        let server = McpStdioServer(name: "everything", command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"])
        let transport = try MCPProcessTransport(server: server)
        let conn = MCPConnection(transport: transport, serverName: "everything")
        try await conn.initialize()
        let tools = try await conn.listTools()
        #expect(tools.count > 0, "server-everything must expose at least one tool")
        print("[live] tool count: \(tools.count)")
        print("[live] tools: \(tools.map(\.name).joined(separator: ", "))")
        let echoResult = try await conn.callTool(name: "echo", argsJSON: #"{"message":"hi"}"#)
        print("[live] echo result: \(echoResult.text)")
        #expect(!echoResult.isError)
        #expect(echoResult.text.contains("hi"))
        await conn.close()
    }
}
