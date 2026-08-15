import Foundation

let mcpMaxNameLength = 64
let mcpMaxToolCount = 64

public struct SkippedTool: Sendable, Equatable {
    public let server: String
    public let tool: String
    public let reason: String
}

enum MCPToolError: Error, Equatable {
    case toolError(String)
}

typealias MCPCall = @Sendable (_ originalName: String, _ argsJSON: String) async throws -> MCPCallResult

struct BuiltServer {
    let name: String
    let tools: [MCPToolInfo]
    let call: MCPCall
}

private let mcpNameUnsafe = try! NSRegularExpression(pattern: "[^A-Za-z0-9_]+")

func exposedName(server: String, tool: String) -> String {
    let raw = "mcp__\(server)__\(tool)"
    let range = NSRange(raw.startIndex..., in: raw)
    return mcpNameUnsafe.stringByReplacingMatches(in: raw, range: range, withTemplate: "_")
}

/// Returns nil when the JSON cannot be decoded as a JSON object (expected for invalid or absent schemas).
func jsonObject(fromJSON json: String) -> [String: JSONValue]? {
    try? JSONDecoder().decode([String: JSONValue].self, from: Data(json.utf8))
}

// The restricted JSON-Schema dialect the realtime backend's client-declared
// gate accepts (`_SCHEMA_ALLOWED_KEYS` in `client_declared.py`). MCP servers
// routinely emit extra keys — `$schema`, `additionalProperties`, `title` — and
// the gate rejects the whole declaration on the first unknown key, so every
// tool would be dropped. Reducing each node to these keys keeps the declaration
// valid without changing the arguments the model produces.
private let mcpSchemaAllowedKeys: Set<String> = [
    "type", "properties", "required", "items", "enum",
    "description", "anyOf", "default", "maxLength", "minLength",
    "maximum", "minimum",
]

private func sanitizeSchemaNode(_ node: JSONValue) -> JSONValue {
    guard case let .object(obj) = node else { return node }
    var out: [String: JSONValue] = [:]
    for (key, value) in obj where mcpSchemaAllowedKeys.contains(key) {
        switch key {
        case "properties":
            if case let .object(props) = value {
                out[key] = .object(props.mapValues(sanitizeSchemaNode))
            }
        case "items":
            out[key] = sanitizeSchemaNode(value)
        case "anyOf":
            if case let .array(variants) = value {
                out[key] = .array(variants.map(sanitizeSchemaNode))
            }
        default:
            out[key] = value
        }
    }
    return .object(out)
}

func normalizedSchema(_ inputSchemaJSON: String?) -> [String: JSONValue]? {
    guard
        let json = inputSchemaJSON,
        let obj = jsonObject(fromJSON: json),
        let type = obj["type"],
        case .string("object") = type
    else {
        return nil
    }
    guard case let .object(sanitized) = sanitizeSchemaNode(.object(obj)) else {
        return nil
    }
    return sanitized
}

func mcpResultObject(from result: MCPCallResult) throws -> [String: JSONValue] {
    if result.isError {
        throw MCPToolError.toolError(result.text.isEmpty ? "MCP tool reported an error" : result.text)
    }
    if let structuredJSON = result.structuredJSON, let obj = jsonObject(fromJSON: structuredJSON) {
        return obj
    }
    return ["text": .string(result.text)]
}

func buildMCPTools(
    _ servers: [BuiltServer],
    reservedNames: Set<String>
) -> (tools: [SessionConfig.Tool], skipped: [SkippedTool]) {
    var tools: [SessionConfig.Tool] = []
    var skipped: [SkippedTool] = []
    var used = reservedNames
    let budget = mcpMaxToolCount - reservedNames.count

    for server in servers {
        for tool in server.tools {
            let name = exposedName(server: server.name, tool: tool.name)
            if name.count > mcpMaxNameLength {
                skipped.append(SkippedTool(server: server.name, tool: tool.name, reason: "name_overflow")); continue
            }
            if used.contains(name) {
                skipped.append(SkippedTool(server: server.name, tool: tool.name, reason: "name_collision")); continue
            }
            guard let parameters = normalizedSchema(tool.inputSchemaJSON) else {
                skipped.append(SkippedTool(server: server.name, tool: tool.name, reason: "invalid_schema")); continue
            }
            if tools.count >= budget {
                skipped.append(SkippedTool(server: server.name, tool: tool.name, reason: "count_overflow")); continue
            }
            used.insert(name)
            let call = server.call
            let original = tool.name
            let handler: ClientToolHandler = { args in
                let argsJSON = String(decoding: try JSONEncoder().encode(args), as: UTF8.self)
                return try await mcpResultObject(from: call(original, argsJSON))
            }
            tools.append(.client(
                name: name,
                description: tool.description ?? tool.name,
                parameters: parameters,
                handler: handler
            ))
        }
    }
    return (tools, skipped)
}
