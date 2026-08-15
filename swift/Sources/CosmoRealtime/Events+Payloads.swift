import Foundation

public enum Role: String, Sendable, Codable {
    case user = "USER"
    case assistant = "ASSISTANT"
}

public struct Ready: Sendable, Equatable, Codable {
    public let sessionId: String

    public init(sessionId: String) {
        self.sessionId = sessionId
    }

    private enum CodingKeys: String, CodingKey {
        case sessionId
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId) ?? ""
    }
}

public struct Transcript: Sendable, Equatable, Codable {
    public let role: Role
    public let text: String
    public let isFinal: Bool
    public init(role: Role, text: String, isFinal: Bool) {
        self.role = role
        self.text = text
        self.isFinal = isFinal
    }
}

public struct ToolCall: Sendable, Equatable, Codable {
    public let callId: String
    public let name: String
    public init(callId: String, name: String) {
        self.callId = callId
        self.name = name
    }
}

public struct ToolResult: Sendable, Equatable, Codable {
    public let callId: String
    public let ok: Bool
    public let summary: String?
    public init(callId: String, ok: Bool, summary: String?) {
        self.callId = callId
        self.ok = ok
        self.summary = summary
    }
}

/// Server-issued ``tool-invocation`` lifecycle message — an informational
/// mirror of a client-tool call whose execution runs out-of-band over
/// LiveKit perform_rpc.
public struct ToolInvocation: Sendable, Equatable {
    public let requestId: String
    public let toolCallId: String
    public let name: String
    public let args: [String: JSONValue]
    /// `false` for an informational mirror whose execution runs out-of-band
    /// (RPC); the caller must not run it. Absent on the wire ⇒ `true`.
    public let executable: Bool

    public init(
        requestId: String,
        toolCallId: String,
        name: String,
        args: [String: JSONValue],
        executable: Bool = true
    ) {
        self.requestId = requestId
        self.toolCallId = toolCallId
        self.name = name
        self.args = args
        self.executable = executable
    }
}

extension ToolInvocation: Decodable {
    private enum CodingKeys: String, CodingKey {
        case requestId
        case toolCallId
        case name
        case args
        case executable
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.requestId = try c.decode(String.self, forKey: .requestId)
        self.toolCallId = try c.decode(String.self, forKey: .toolCallId)
        self.name = try c.decode(String.self, forKey: .name)
        self.args = try c.decodeIfPresent([String: JSONValue].self, forKey: .args) ?? [:]
        self.executable = try c.decodeIfPresent(Bool.self, forKey: .executable) ?? true
    }
}

public struct ServerError: Sendable, Equatable, Codable {
    public let code: String
    public let message: String
    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }
}
