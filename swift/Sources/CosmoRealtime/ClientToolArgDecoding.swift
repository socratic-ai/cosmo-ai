import Foundation

public extension JSONValue {
    /// The numeric value when this is a JSON number, accepting either form a model
    /// emits — `.double(0.5)` or a bare `.int(0)`. `nil` for any non-number. The
    /// shared primitive for decoding numeric client-tool arguments.
    var asDouble: Double? {
        switch self {
        case let .double(d): return d
        case let .int(i): return Double(i)
        default: return nil
        }
    }
}

public extension NormalizedBox {
    /// Decode a normalized box from a `{x,y,width,height}` JSON object (each a
    /// number in either form). Returns `nil` when `value` isn't such an object or a
    /// field is missing / non-numeric — a boundary check on model output. Raw: does
    /// NOT clamp; callers that need `[0,1]` clamp downstream.
    init?(json value: JSONValue?) {
        guard case let .object(fields)? = value,
              let x = fields["x"]?.asDouble,
              let y = fields["y"]?.asDouble,
              let width = fields["width"]?.asDouble,
              let height = fields["height"]?.asDouble else { return nil }
        self.init(x: x, y: y, width: width, height: height)
    }
}

public extension NormalizedPoint {
    /// Decode a normalized point from an `{x,y}` JSON object, on the same terms
    /// as ``NormalizedBox/init(json:)`` — boundary check, no clamping.
    init?(json value: JSONValue?) {
        guard case let .object(fields)? = value,
              let x = fields["x"]?.asDouble,
              let y = fields["y"]?.asDouble else { return nil }
        self.init(x: x, y: y)
    }
}
