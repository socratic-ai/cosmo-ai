import Foundation

/// A normalized rectangle in `[0,1]`, **top-left origin** (y increases downward)
/// — the coordinate convention the on-device Vision tools report
/// (`FaceLandmarks.Box`) and that a preview overlay maps onto the screen.
public struct NormalizedBox: Sendable, Equatable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }
}

/// One model request to draw a box over the user's live view: where, and an optional
/// short caption. Decoded from a `cosmo_sdk_draw_box` invocation's arguments.
public struct DrawBoxRequest: Sendable, Equatable {
    public var box: NormalizedBox
    public var label: String?

    public init(box: NormalizedBox, label: String? = nil) {
        self.box = box
        self.label = label
    }
}

/// `cosmo_sdk_draw_box` — the renderer half of the locate-then-draw pair. A
/// server-side locator (`cosmo_detect_objects`, or an on-device Vision tool) returns
/// candidate boxes to the model; the model picks the one that matches what it
/// is looking at and passes it here. Naming it for the call it follows is what
/// keeps the model from confusing the two halves.
///
/// It measures nothing — it carries the model's choice to the client UI. The
/// SDK owns the contract (declaration + typed decode); the app owns the
/// drawing. Coordinates are normalized to the frame the model was shown, so
/// the app maps them onto the preview the same way it maps a Vision tool's
/// `bounding_box`.
public enum DrawBoxTool {
    /// Wire name shipped in `tool-invocation` events; a rename is a wire break.
    /// Matches the backend regex `^[a-z][a-z0-9_]{2,63}$` (`client_declared.py`).
    public static let name = "cosmo_sdk_draw_box"

    /// Tool-group key for backend telemetry + brain-allowlisting.
    public static let group = "ui"

    public static var toolDescription: String {
        """
        Draw a box over the user's live view (their camera or screen preview) around \
        something cosmo_detect_objects located — pass a box \
        it returned, normalized to the frame you were shown ([0,1], top-left origin), and an \
        optional short label. Call this after cosmo_detect_objects rather than guessing a box \
        yourself. Visual only — it measures nothing and changes nothing.
        """
    }

    /// Args JSON-schema in the backend's restricted dialect.
    public static var parametersJSON: String {
        #"""
        {"type":"object","properties":{"box":{"type":"object","description":"Where to draw, normalized to the frame you were shown: [0,1], top-left origin.","properties":{"x":{"type":"number","minimum":0,"maximum":1},"y":{"type":"number","minimum":0,"maximum":1},"width":{"type":"number","minimum":0,"maximum":1},"height":{"type":"number","minimum":0,"maximum":1}},"required":["x","y","width","height"]},"label":{"type":"string","maxLength":40,"description":"Short caption shown on the box, e.g. 'blush here'."}},"required":["box"]}
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

    /// Decode a `cosmo_sdk_draw_box` invocation's arguments into a typed request.
    /// Returns `nil` when the box is absent or malformed — a boundary check on
    /// model output, not an invariant. Coordinates are clamped to `[0,1]` so a
    /// model that overshoots the edge still yields a drawable box.
    public static func request(from args: [String: JSONValue]) -> DrawBoxRequest? {
        guard let raw = NormalizedBox(json: args["box"]) else { return nil }
        let box = NormalizedBox(
            x: clamp01(raw.x), y: clamp01(raw.y),
            width: clamp01(raw.width), height: clamp01(raw.height)
        )
        var label: String?
        if case let .string(s)? = args["label"] { label = s }
        return DrawBoxRequest(box: box, label: label)
    }

    private static func clamp01(_ v: Double) -> Double { min(1, max(0, v)) }
}

/// Thrown by the SDK-provided draw tools when the model's arguments don't
/// decode; surfaces as the invocation's error envelope.
struct DrawRequestDecodeError: Error, LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// Decode an SDK-shipped tool's schema literal into the typed parameters
/// ``AgentTool/client(name:description:parameters:handler:)``
/// carries. The literals are compile-time constants pinned by
/// ``ClientToolSchemaDialectTests``, so a decode failure is a programmer
/// error, not a runtime condition.
func sdkToolParameters(fromJSON json: String) -> [String: JSONValue] {
    // swiftlint:disable:next force_try
    try! JSONDecoder().decode([String: JSONValue].self, from: Data(json.utf8))
}

extension AgentTool {
    /// The box renderer, ready to add to ``RealtimeAgent/tools`` alongside
    /// the locator that feeds it:
    ///
    /// ```swift
    /// tools: [.detectObjects, .drawBox { request in
    ///     guard camera.isStreaming else {
    ///         return .notShown("the camera is off — ask the user to turn it on")
    ///     }
    ///     show(request)
    ///     return .shown
    /// }]
    /// ```
    ///
    /// The SDK owns both ends of the wire: it decodes and clamps the
    /// arguments into a ``DrawBoxRequest`` on the main actor, and it turns
    /// the returned ``DrawOutcome`` into the model's tool result. Your
    /// handler owns only the drawing — and the honest answer about whether
    /// it happened, since a box reported as shown but invisible leaves the
    /// model talking about something the user cannot see. Malformed
    /// arguments surface to the model as the invocation's error without
    /// reaching your code.
    public static func drawBox(
        onDraw: @escaping @MainActor @Sendable (DrawBoxRequest) -> DrawOutcome
    ) -> AgentTool {
        .sdkClient(SDKClientTool(
            name: DrawBoxTool.name,
            description: DrawBoxTool.toolDescription,
            parameters: sdkToolParameters(fromJSON: DrawBoxTool.parametersJSON),
            handler: { args in
                guard let request = DrawBoxTool.request(from: args) else {
                    throw DrawRequestDecodeError(
                        message: "\(DrawBoxTool.name): pass box {x,y,width,height} normalized to [0,1]"
                    )
                }
                return await MainActor.run { onDraw(request) }.toolResult
            }
        ))
    }
}
