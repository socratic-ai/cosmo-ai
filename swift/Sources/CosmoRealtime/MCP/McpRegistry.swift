import Foundation
import OSLog

public typealias MCPTransportFactory = @Sendable (McpStdioServer) throws -> MCPTransport

/// A per-session live MCP handle: the proxy tools and idempotent teardown of
/// every server connection.
public actor ConnectedMcp {
    public let tools: [SessionConfig.Tool]
    public let skipped: [SkippedTool]
    private let connections: [MCPConnection]
    private var closed = false

    init(tools: [SessionConfig.Tool], skipped: [SkippedTool], connections: [MCPConnection]) {
        self.tools = tools
        self.skipped = skipped
        self.connections = connections
    }

    public func aclose() async {
        if closed { return }
        closed = true
        for connection in connections { await connection.close() }
    }
}

/// Connection-free index of MCP servers. Reused across sessions; each
/// `connect()` opens fresh subprocesses.
public struct McpRegistry: Sendable {
    private static let log = Logger(subsystem: CosmoRealtimeLog.subsystem, category: "mcp")

    private let servers: [McpStdioServer]

    public init(servers: [McpStdioServer]) {
        self.servers = servers
    }

    public static func fromConfigFile(_ url: URL) throws -> McpRegistry {
        let (servers, skippedRemote) = try parseMCPConfig(Data(contentsOf: url))
        for name in skippedRemote {
            log.warning("MCP server '\(name)' skipped: remote servers are not supported")
        }
        return McpRegistry(servers: servers)
    }

    func connect(
        reservedNames: Set<String>,
        transportFactory: MCPTransportFactory
    ) async throws -> ConnectedMcp {
        var connections: [MCPConnection] = []
        var built: [BuiltServer] = []
        for server in servers {
            let transport: MCPTransport
            do {
                transport = try transportFactory(server)
            } catch {
                Self.log.warning("MCP server '\(server.name)' (command: \(server.command), args: \(server.args.count)) skipped: transport failed: \(error)")
                continue
            }
            let connection = MCPConnection(transport: transport, serverName: server.name)
            do {
                try await connection.initialize()
                let listed = try await connection.listTools()
                connections.append(connection)
                built.append(BuiltServer(name: server.name, tools: listed, call: { name, argsJSON in
                    try await connection.callTool(name: name, argsJSON: argsJSON)
                }))
            } catch {
                Self.log.warning("MCP server '\(server.name)' (command: \(server.command), args: \(server.args.count)) skipped: initialization failed: \(error)")
                await connection.close()
            }
        }
        let (tools, skipped) = buildMCPTools(built, reservedNames: reservedNames)
        return ConnectedMcp(tools: tools, skipped: skipped, connections: connections)
    }
}
