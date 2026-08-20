import Foundation

/// One model request to mark a spot over the user's live view: where, and an
/// optional short caption. Decoded from a `cosmo_sdk_draw_point` invocation.
public struct DrawPointRequest: Sendable, Equatable {
    public var point: NormalizedPoint
    public var label: String?

    public init(point: NormalizedPoint, label: String? = nil) {
        self.point = point
        self.label = label
    }
}

/// `cosmo_sdk_draw_point` — the renderer half of the point-then-mark pair, the
/// sibling of ``DrawBoxTool``. `cosmo_point_at_object` returns candidate
/// positions to the model; the model picks one and passes it here.
///
/// It exists next to the box renderer because the two answer different
/// questions: a box around a leaf includes everything behind it, where a
/// marked point says one thing.
public enum DrawPointTool {
    /// Wire name shipped in `tool-invocation` events; a rename is a wire break.
    /// Matches the backend regex `^[a-z][a-z0-9_]{2,63}$` (`client_declared.py`).
    public static let name = "cosmo_sdk_draw_point"

    /// Tool-group key for backend telemetry + brain-allowlisting.
    public static let group = "ui"

    public static var toolDescription: String {
        """
        Mark a single spot on the user's live view (their camera or screen preview) — one \
        leaf, one screw, one control — using a \
        point cosmo_point_at_object returned, normalized to the frame you were shown ([0,1], top-left \
        origin), with an optional short label. Call this after cosmo_point_at_object rather than \
        guessing a position yourself. Visual only — it measures nothing and changes nothing.
        """
    }

    /// Args JSON-schema in the backend's restricted dialect.
    public static var parametersJSON: String {
        #"""
        {"type":"object","properties":{"point":{"type":"object","description":"Where to point, normalized to the frame you were shown: [0,1], top-left origin.","properties":{"x":{"type":"number","minimum":0,"maximum":1},"y":{"type":"number","minimum":0,"maximum":1}},"required":["x","y"]},"label":{"type":"string","maxLength":40,"description":"Short caption shown beside the marker, e.g. 'this screw'."}},"required":["point"]}
        """#
    }

    /// The declaration advertised at connect.
    public static func declaredTool() -> DeclaredClientTool {
        DeclaredClientTool(
            name: name,
            description: toolDescription,
            parametersJSON: parametersJSON,
            group: group
        )
    }

    /// Decode a `cosmo_sdk_draw_point` invocation's arguments into a typed request.
    /// Returns `nil` when the point is absent or malformed — a boundary check on
    /// model output, not an invariant. Coordinates are clamped to `[0,1]` so a
    /// model that overshoots the edge still yields a drawable marker.
    public static func request(from args: [String: JSONValue]) -> DrawPointRequest? {
        guard let raw = NormalizedPoint(json: args["point"]) else { return nil }
        var label: String?
        if case let .string(s)? = args["label"] { label = s }
        return DrawPointRequest(
            point: NormalizedPoint(x: clamp01(raw.x), y: clamp01(raw.y)),
            label: label
        )
    }

    private static func clamp01(_ v: Double) -> Double { min(1, max(0, v)) }
}

extension AgentTool {
    /// The point renderer, ready to add to ``RealtimeAgent/tools`` alongside
    /// the locator that feeds it. Same contract as
    /// ``drawBox(onDraw:)``, with a ``DrawPointRequest``.
    public static func drawPoint(
        onDraw: @escaping @MainActor @Sendable (DrawPointRequest) -> DrawOutcome
    ) -> AgentTool {
        .sdkClient(SDKClientTool(
            name: DrawPointTool.name,
            description: DrawPointTool.toolDescription,
            parameters: sdkToolParameters(fromJSON: DrawPointTool.parametersJSON),
            handler: { args in
                guard let request = DrawPointTool.request(from: args) else {
                    throw DrawRequestDecodeError(
                        message: "\(DrawPointTool.name): pass point {x,y} normalized to [0,1]"
                    )
                }
                return await MainActor.run { onDraw(request) }.toolResult
            }
        ))
    }
}
