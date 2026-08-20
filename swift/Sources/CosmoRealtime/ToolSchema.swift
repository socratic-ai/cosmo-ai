import Foundation

/// A dialect-correct-by-construction schema for a client tool's arguments,
/// built from `.object` / `.string` / `.number` / `.integer` / `.boolean` /
/// `.array` / `.enum` / `.anyOf` / `.null` nodes. Each node carries only the
/// attributes the backend's restricted dialect accepts (`description`,
/// `default`, bounds), so a ``AgentTool/define(name:description:input:handler:)``
/// schema can only fail the dialect check on the caps (depth ≤ 6, ≤ 64
/// properties globally) or on text sanitization.
///
/// `default` and the bounds (`minimum` / `maximum` / `minLength` /
/// `maxLength`) are model guidance only — decoding does not apply or enforce
/// them (see ``AgentTool/define(name:description:input:handler:)``).
public struct ToolSchema: Sendable, Equatable {
    indirect enum Node: Sendable, Equatable {
        case object(properties: [String: ToolSchema], required: [String], description: String?)
        case string(description: String?, minLength: Int?, maxLength: Int?, defaultValue: String?)
        case number(description: String?, minimum: Double?, maximum: Double?, defaultValue: Double?)
        case integer(description: String?, minimum: Int?, maximum: Int?, defaultValue: Int?)
        case boolean(description: String?, defaultValue: Bool?)
        case array(items: ToolSchema?, description: String?)
        case choice(values: [String], description: String?, defaultValue: String?)
        case anyOf(variants: [ToolSchema], description: String?)
        case null
    }

    let node: Node

    public static func object(
        properties: [String: ToolSchema],
        required: [String] = [],
        description: String? = nil
    ) -> ToolSchema {
        ToolSchema(node: .object(properties: properties, required: required, description: description))
    }

    public static func string(
        description: String? = nil,
        minLength: Int? = nil,
        maxLength: Int? = nil,
        default defaultValue: String? = nil
    ) -> ToolSchema {
        ToolSchema(node: .string(
            description: description, minLength: minLength, maxLength: maxLength,
            defaultValue: defaultValue
        ))
    }

    public static func number(
        description: String? = nil,
        minimum: Double? = nil,
        maximum: Double? = nil,
        default defaultValue: Double? = nil
    ) -> ToolSchema {
        ToolSchema(node: .number(
            description: description, minimum: minimum, maximum: maximum,
            defaultValue: defaultValue
        ))
    }

    public static func integer(
        description: String? = nil,
        minimum: Int? = nil,
        maximum: Int? = nil,
        default defaultValue: Int? = nil
    ) -> ToolSchema {
        ToolSchema(node: .integer(
            description: description, minimum: minimum, maximum: maximum,
            defaultValue: defaultValue
        ))
    }

    public static func boolean(
        description: String? = nil,
        default defaultValue: Bool? = nil
    ) -> ToolSchema {
        ToolSchema(node: .boolean(description: description, defaultValue: defaultValue))
    }

    public static func array(
        items: ToolSchema? = nil,
        description: String? = nil
    ) -> ToolSchema {
        ToolSchema(node: .array(items: items, description: description))
    }

    /// A string constrained to `values` — decodes cleanly into a
    /// `String`-backed `Decodable` enum with matching raw values.
    public static func `enum`(
        _ values: [String],
        description: String? = nil,
        default defaultValue: String? = nil
    ) -> ToolSchema {
        ToolSchema(node: .choice(values: values, description: description, defaultValue: defaultValue))
    }

    public static func anyOf(
        _ variants: [ToolSchema],
        description: String? = nil
    ) -> ToolSchema {
        ToolSchema(node: .anyOf(variants: variants, description: description))
    }

    /// The JSON `null` type — combine with `.anyOf` for a nullable field.
    public static var null: ToolSchema { ToolSchema(node: .null) }

    /// The schema as the wire-ready `parameters` object of the restricted
    /// dialect.
    public func lowered() -> [String: JSONValue] {
        switch node {
        case .object(let properties, let required, let description):
            var out: [String: JSONValue] = [
                "type": .string("object"),
                "properties": .object(properties.mapValues { .object($0.lowered()) }),
            ]
            if !required.isEmpty { out["required"] = .array(required.map(JSONValue.string)) }
            if let description { out["description"] = .string(description) }
            return out
        case .string(let description, let minLength, let maxLength, let defaultValue):
            var out: [String: JSONValue] = ["type": .string("string")]
            if let description { out["description"] = .string(description) }
            if let minLength { out["minLength"] = .int(minLength) }
            if let maxLength { out["maxLength"] = .int(maxLength) }
            if let defaultValue { out["default"] = .string(defaultValue) }
            return out
        case .number(let description, let minimum, let maximum, let defaultValue):
            var out: [String: JSONValue] = ["type": .string("number")]
            if let description { out["description"] = .string(description) }
            if let minimum { out["minimum"] = .double(minimum) }
            if let maximum { out["maximum"] = .double(maximum) }
            if let defaultValue { out["default"] = .double(defaultValue) }
            return out
        case .integer(let description, let minimum, let maximum, let defaultValue):
            var out: [String: JSONValue] = ["type": .string("integer")]
            if let description { out["description"] = .string(description) }
            if let minimum { out["minimum"] = .int(minimum) }
            if let maximum { out["maximum"] = .int(maximum) }
            if let defaultValue { out["default"] = .int(defaultValue) }
            return out
        case .boolean(let description, let defaultValue):
            var out: [String: JSONValue] = ["type": .string("boolean")]
            if let description { out["description"] = .string(description) }
            if let defaultValue { out["default"] = .bool(defaultValue) }
            return out
        case .array(let items, let description):
            var out: [String: JSONValue] = ["type": .string("array")]
            if let items { out["items"] = .object(items.lowered()) }
            if let description { out["description"] = .string(description) }
            return out
        case .choice(let values, let description, let defaultValue):
            var out: [String: JSONValue] = [
                "type": .string("string"),
                "enum": .array(values.map(JSONValue.string)),
            ]
            if let description { out["description"] = .string(description) }
            if let defaultValue { out["default"] = .string(defaultValue) }
            return out
        case .anyOf(let variants, let description):
            var out: [String: JSONValue] = [
                "anyOf": .array(variants.map { .object($0.lowered()) })
            ]
            if let description { out["description"] = .string(description) }
            return out
        case .null:
            return ["type": .string("null")]
        }
    }

    /// A sample value conforming to the schema, for
    /// ``ToolSchemaConsistencyCheck``. Uses declared defaults where present
    /// and respects declared bounds.
    func sampleValue(includeOptionalProperties: Bool) -> JSONValue {
        switch node {
        case .object(let properties, let required, _):
            var out: [String: JSONValue] = [:]
            for (name, schema) in properties
            where includeOptionalProperties || required.contains(name) {
                out[name] = schema.sampleValue(includeOptionalProperties: includeOptionalProperties)
            }
            return .object(out)
        case .string(_, let minLength, let maxLength, let defaultValue):
            if let defaultValue { return .string(defaultValue) }
            var sample = "sample"
            if let minLength, sample.count < minLength {
                sample += String(repeating: "a", count: minLength - sample.count)
            }
            if let maxLength, sample.count > maxLength {
                sample = String(sample.prefix(maxLength))
            }
            return .string(sample)
        case .number(_, let minimum, let maximum, let defaultValue):
            if let defaultValue { return .double(defaultValue) }
            var sample = minimum ?? 0
            if let maximum, sample > maximum { sample = maximum }
            return .double(sample)
        case .integer(_, let minimum, let maximum, let defaultValue):
            if let defaultValue { return .int(defaultValue) }
            var sample = minimum ?? 0
            if let maximum, sample > maximum { sample = maximum }
            return .int(sample)
        case .boolean(_, let defaultValue):
            return .bool(defaultValue ?? true)
        case .array(let items, _):
            guard let items else { return .array([]) }
            return .array([items.sampleValue(includeOptionalProperties: includeOptionalProperties)])
        case .choice(let values, _, let defaultValue):
            return .string(defaultValue ?? values.first ?? "")
        case .anyOf(let variants, _):
            let variant = variants.first { $0.node != .null } ?? variants.first
            return variant?.sampleValue(includeOptionalProperties: includeOptionalProperties) ?? .null
        case .null:
            return .null
        }
    }
}
