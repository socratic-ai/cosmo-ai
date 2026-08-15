import Foundation

/// Errors raised by an MCP transport / connection.
public enum MCPError: Error, Equatable {
    case transport(String)
    case rpc(String)
}

/// The injectable boundary between ``MCPConnection`` and the wire. The
/// production impl is ``MCPProcessTransport`` (stdio subprocess); tests inject
/// an in-memory fake. `request` returns the JSON-RPC `result` member as JSON
/// text, or throws ``MCPError`` on a JSON-RPC `error`. `notify` is
/// fire-and-forget; implementations log write failures but do not propagate them.
public protocol MCPTransport: Sendable {
    func request(method: String, paramsJSON: String) async throws -> String
    func notify(method: String, paramsJSON: String) async
    func close() async
}
