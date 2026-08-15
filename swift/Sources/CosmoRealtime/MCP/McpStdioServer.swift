// Sources/CosmoRealtime/MCP/McpStdioServer.swift
import Foundation

/// One local MCP server launched over stdio.
public struct McpStdioServer: Sendable, Equatable {
    public var name: String
    public var command: String
    public var args: [String]
    public var env: [String: String]?
    public var cwd: String?

    public init(
        name: String,
        command: String,
        args: [String] = [],
        env: [String: String]? = nil,
        cwd: String? = nil
    ) {
        self.name = name
        self.command = command
        self.args = args
        self.env = env
        self.cwd = cwd
    }
}

public enum MCPConfigError: Error, Equatable {
    case malformed(String)
}

private let remoteTypes: Set<String> = ["http", "sse"]

/// Parse a Claude-Code `.mcp.json`. Returns the stdio servers plus the names
/// of remote entries skipped in v1.
public func parseMCPConfig(_ data: Data) throws -> (servers: [McpStdioServer], skippedRemote: [String]) {
    guard
        let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
        let raw = root["mcpServers"] as? [String: Any]
    else {
        throw MCPConfigError.malformed("`.mcp.json` must contain an object 'mcpServers'")
    }
    var servers: [McpStdioServer] = []
    var skippedRemote: [String] = []
    for name in raw.keys.sorted() {
        guard let entry = raw[name] as? [String: Any] else {
            throw MCPConfigError.malformed("server \(name) must be an object")
        }
        if entry["url"] != nil || (entry["type"] as? String).map(remoteTypes.contains) == true {
            skippedRemote.append(name)
            continue
        }
        guard let command = entry["command"] as? String, !command.isEmpty else {
            throw MCPConfigError.malformed("server \(name) must include a 'command'")
        }
        let args = (entry["args"] as? [Any])?.map { String(describing: $0) } ?? []
        servers.append(McpStdioServer(
            name: name,
            command: command,
            args: args,
            env: entry["env"] as? [String: String],
            cwd: entry["cwd"] as? String
        ))
    }
    return (servers, skippedRemote)
}
