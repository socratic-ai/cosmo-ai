import Foundation

/// Type-safe representation of an arbitrary JSON value, used at SDK
/// boundaries where the wire payload is a free-form JSON object
/// (e.g. a client tool's ``result`` payload).
///
/// Prefer this over ``[String: Any]`` so the compiler can verify the
/// payload is actually JSON-shaped — no surprise ``Date``, ``URL``, or
/// ``Decimal`` values that ``JSONSerialization`` would throw on at
/// runtime. ``Codable`` so callers can encode their own types into a
/// ``JSONValue`` via ``JSONEncoder``.
public enum JSONValue: Sendable, Equatable {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)
    case null
    case array([JSONValue])
    case object([String: JSONValue])
}

extension JSONValue: Codable {
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        if let b = try? c.decode(Bool.self)            { self = .bool(b);   return }
        if let i = try? c.decode(Int.self)             { self = .int(i);    return }
        if let d = try? c.decode(Double.self)          { self = .double(d); return }
        if let s = try? c.decode(String.self)          { self = .string(s); return }
        if let a = try? c.decode([JSONValue].self)     { self = .array(a);  return }
        if let o = try? c.decode([String: JSONValue].self) { self = .object(o); return }
        throw DecodingError.dataCorruptedError(in: c, debugDescription: "Unsupported JSON value")
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let v): try c.encode(v)
        case .int(let v):    try c.encode(v)
        case .double(let v): try c.encode(v)
        case .bool(let v):   try c.encode(v)
        case .null:          try c.encodeNil()
        case .array(let v):  try c.encode(v)
        case .object(let v): try c.encode(v)
        }
    }
}

extension JSONValue {
    /// Convert to a plain ``[String: Any]`` for ``JSONSerialization``
    /// interop (internal use only — the public API is the typed enum).
    internal var rawAny: Any {
        switch self {
        case .null: return NSNull()
        case .bool(let b): return b
        case .int(let i): return i
        case .double(let d): return d
        case .string(let s): return s
        case .array(let arr): return arr.map { $0.rawAny }
        case .object(let obj):
            var out: [String: Any] = [:]
            for (k, v) in obj { out[k] = v.rawAny }
            return out
        }
    }
}
