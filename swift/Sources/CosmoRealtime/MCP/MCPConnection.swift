import Foundation
import OSLog

/// One listed MCP tool: its name, optional description, and the raw JSON text
/// of its `inputSchema` (re-serialized so it can pass through as a
/// ``DeclaredClientTool`` parameters schema).
public struct MCPToolInfo: Sendable, Equatable {
    public let name: String
    public let description: String?
    public let inputSchemaJSON: String?
}

/// The result of a `tools/call`, flattened for the reply envelope.
public struct MCPCallResult: Sendable, Equatable {
    public let isError: Bool
    public let text: String
    public let structuredJSON: String?
}

/// A live MCP session over a ``MCPTransport``. Actor-isolated, so calls to one
/// server serialize (a single MCP session is not assumed concurrency-safe).
actor MCPConnection {
    private static let log = Logger(subsystem: CosmoRealtimeLog.subsystem, category: "mcp")

    private let transport: MCPTransport
    private let serverName: String

    init(transport: MCPTransport, serverName: String) {
        self.transport = transport
        self.serverName = serverName
    }

    func initialize() async throws {
        _ = try await transport.request(
            method: "initialize",
            paramsJSON: #"{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"cosmo-realtime-swift","version":"0"}}"#
        )
        await transport.notify(method: "notifications/initialized", paramsJSON: "{}")
    }

    func listTools() async throws -> [MCPToolInfo] {
        let resultJSON = try await transport.request(method: "tools/list", paramsJSON: "{}")
        let name = serverName
        guard
            let obj = try? JSONSerialization.jsonObject(with: Data(resultJSON.utf8)) as? [String: Any],
            let rawTools = obj["tools"] as? [[String: Any]]
        else {
            let preview = String(resultJSON.prefix(200))
            throw MCPError.transport("MCP '\(name)': tools/list result not the expected shape: \(preview)")
        }
        return rawTools.compactMap { raw in
            guard let name = raw["name"] as? String else { return nil }
            var schemaJSON: String?
            if let schema = raw["inputSchema"], JSONSerialization.isValidJSONObject(schema),
               let data = try? JSONSerialization.data(withJSONObject: schema) {
                schemaJSON = String(decoding: data, as: UTF8.self)
            }
            return MCPToolInfo(
                name: name,
                description: raw["description"] as? String,
                inputSchemaJSON: schemaJSON
            )
        }
    }

    /// Calls a named tool on the server. The `name` is JSON-serialized safely by
    /// this function; callers do not need to pre-escape it.
    func callTool(name: String, argsJSON: String) async throws -> MCPCallResult {
        let server = serverName
        let parsedArgs = (try? JSONSerialization.jsonObject(with: Data(argsJSON.utf8))) ?? [String: Any]()
        let paramsData = try JSONSerialization.data(withJSONObject: ["name": name, "arguments": parsedArgs])
        let params = String(decoding: paramsData, as: UTF8.self)
        let resultJSON = try await transport.request(method: "tools/call", paramsJSON: params)
        guard let obj = (try? JSONSerialization.jsonObject(with: Data(resultJSON.utf8))) as? [String: Any] else {
            throw MCPError.transport("MCP '\(server)': tools/call response failed to parse: \(resultJSON.prefix(200))")
        }
        let isError = obj["isError"] as? Bool ?? false
        let blocks = obj["content"] as? [[String: Any]] ?? []
        let text = blocks
            .filter { ($0["type"] as? String) == "text" }
            .compactMap { $0["text"] as? String }
            .joined(separator: "\n")
        var structuredJSON: String?
        if let structured = obj["structuredContent"] {
            if JSONSerialization.isValidJSONObject(structured),
               let data = try? JSONSerialization.data(withJSONObject: structured) {
                structuredJSON = String(decoding: data, as: UTF8.self)
            } else {
                let preview = String(describing: structured).prefix(200)
                Self.log.warning("MCP '\(server)': structuredContent could not be serialized to JSON: \(preview)")
            }
        }
        return MCPCallResult(isError: isError, text: text, structuredJSON: structuredJSON)
    }

    func close() async { await transport.close() }
}
