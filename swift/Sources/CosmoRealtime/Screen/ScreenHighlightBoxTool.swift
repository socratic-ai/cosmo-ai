import Foundation

/// What a box-highlight handler is asked to do: where, as fractions of the
/// shared surface, the tooltip to show, and — when the model could read the
/// control's own name off the screen — what it is called.
public struct ScreenHighlightBoxRequest: Sendable, Equatable {
    public var box: ScreenBox
    /// The model's guess at what the target is *called*, distinct from the
    /// located element a handle resolves to. A host with an accessibility tree
    /// can snap the highlight onto that exact control instead of the estimated
    /// box; `nil` when the model could read no name.
    public var elementGuess: ScreenElementHint?
    public var label: String
    public var placement: ScreenPlacement
    public var interaction: ScreenAffordance

    public init(
        box: ScreenBox,
        elementGuess: ScreenElementHint? = nil,
        label: String,
        placement: ScreenPlacement = .auto,
        interaction: ScreenAffordance = .click
    ) {
        self.box = box
        self.elementGuess = elementGuess
        self.label = label
        self.placement = placement
        self.interaction = interaction
    }
}

/// What either highlight reports back to the model.
///
/// ``exact`` answers the question a highlight raises and a click does not: it is
/// showing, but is it *on* the thing? A host that resolved the target to a real
/// control reports `true`; one that could only draw where the model guessed
/// reports `false`, which is the model's cue to re-target through
/// `cosmo_screen_locate` rather than leave a marker sitting next to the control.
///
/// Shared by ``SessionConfig/Tool/screenHighlightBox(onHighlight:)`` and
/// ``SessionConfig/Tool/screenHighlightElement(onHighlight:)`` so the model
/// reads the same field whichever it called. From a grounded handle the answer
/// is always ``landedOnControl``.
public struct ScreenHighlightOutcome: Sendable, Equatable {
    /// Shown, and on a real control.
    public static let landedOnControl =
        ScreenHighlightOutcome(shown: true, exact: true, reason: nil)

    /// Shown, but only where the model estimated — nothing on screen matched.
    public static let landedOnEstimate =
        ScreenHighlightOutcome(shown: true, exact: false, reason: nil)

    /// Nothing was drawn. ``reason`` is model-facing: it is what the agent tells
    /// the user, so write it as an instruction ("the user stopped sharing their
    /// screen"), not as an error code.
    public static func notShown(_ reason: String) -> ScreenHighlightOutcome {
        ScreenHighlightOutcome(shown: false, exact: false, reason: reason)
    }

    public let shown: Bool
    public let exact: Bool
    public let reason: String?

    private init(shown: Bool, exact: Bool, reason: String?) {
        self.shown = shown
        self.exact = exact
        self.reason = reason
    }

    /// The tool result the model receives. Exactness rides only a highlight that
    /// is actually up — there is nothing to be exact about otherwise.
    var toolResult: [String: JSONValue] {
        var result: [String: JSONValue] = ["shown": .bool(shown)]
        if shown { result["exact"] = .bool(exact) }
        if let reason { result["reason"] = .string(reason) }
        return result
    }
}

/// `cosmo_sdk_screen_highlight_box` — the highlight that needs no locator. The
/// model gives the box itself, so it draws immediately instead of paying for a
/// capture and a grounding pass, which is why it is the default way to point at
/// something.
///
/// The price is that the box is an estimate, and the reply says so: a host that
/// could snap onto a real control answers exact, one that could not answers
/// inexact, and inexact is what sends the model to `cosmo_screen_locate` for
/// the handle-based renderers.
public enum ScreenHighlightBoxTool {
    /// Wire name shipped in `tool-invocation` events; a rename is a wire break.
    /// Matches the backend regex `^[a-z][a-z0-9_]{2,63}$` (`client_declared.py`).
    public static let name = "cosmo_sdk_screen_highlight_box"

    /// Tool-group key for backend telemetry + brain-allowlisting.
    public static let group = "screen"

    public static var toolDescription: String {
        """
        Highlight a target on the shared screen, given its box as fractions of the surface \
        and a tooltip label. This is the default way to point at something: it draws \
        instantly, with no capture or lookup. Reach for cosmo_screen_locate and \
        cosmo_sdk_screen_highlight_element only when you cannot give a box, or when this \
        answered exact: false. A screen tool: it draws on the user's actual screen, so use \
        it only for the shared screen — never for a camera feed, and never with a box taken \
        from a camera frame.
        """
    }

    /// Args JSON-schema in the backend's restricted dialect.
    public static var parametersJSON: String {
        #"""
        {"type":"object","properties":{"x":{"type":"number","minimum":0,"maximum":1,"description":"Target box left edge, fraction 0-1 of the shared surface width."},"y":{"type":"number","minimum":0,"maximum":1,"description":"Target box top edge, fraction 0-1 of the shared surface height (0 = top)."},"width":{"type":"number","minimum":0,"maximum":1,"description":"Target box width, fraction 0-1 of the surface width."},"height":{"type":"number","minimum":0,"maximum":1,"description":"Target box height, fraction 0-1 of the surface height."},"label":{"type":"string","maxLength":80,"description":"Tooltip text shown beside the highlight."},"element_title":{"type":"string","maxLength":200,"description":"The control's own visible text, when it has one, e.g. 'Files changed'. When it matches the app's accessibility tree the highlight snaps onto that exact control instead of your box. Send the box regardless — many apps expose no usable label."},"element_role":{"type":"string","maxLength":64,"description":"Accessibility role disambiguating the title match, e.g. 'AXButton'."},"placement":{"type":"string","enum":["auto","top","bottom","left","right"],"description":"Which side of the target the tooltip sits on."},"interaction":{"type":"string","enum":["pointer","click","double_click","left_click","right_click","drag_show","press_hold","inform"],"description":"Which glyph the highlight draws — the action being asked of the user."}},"required":["x","y","width","height","label"]}
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

    /// Decode a `cosmo_sdk_screen_highlight_box` invocation's arguments into a
    /// typed request. Returns `nil` when a coordinate or the tooltip is absent or
    /// non-numeric; coordinates are clamped to `[0,1]` so a model that overshoots
    /// the edge still yields a drawable box, matching the draw renderers.
    public static func request(from args: [String: JSONValue]) -> ScreenHighlightBoxRequest? {
        guard
            let x = args["x"]?.doubleValue,
            let y = args["y"]?.doubleValue,
            let width = args["width"]?.doubleValue,
            let height = args["height"]?.doubleValue,
            let label = args["label"]?.stringValue
        else { return nil }
        return ScreenHighlightBoxRequest(
            box: ScreenBox(
                x: ScreenArgs.clamp01(x),
                y: ScreenArgs.clamp01(y),
                width: ScreenArgs.clamp01(width),
                height: ScreenArgs.clamp01(height)
            ),
            elementGuess: elementHint(args),
            label: label,
            placement: ScreenArgs.placement(args),
            interaction: ScreenArgs.affordance(args)
        )
    }

    /// The optional "what it's called" hint. Absent or blank means the model
    /// could not read a name off the target, which is normal — it is a bonus
    /// signal, never a requirement.
    private static func elementHint(_ args: [String: JSONValue]) -> ScreenElementHint? {
        guard let title = args["element_title"]?.stringValue,
              !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return nil }
        let role = args["element_role"]?.stringValue
        return ScreenElementHint(title: title, role: (role?.isEmpty == false) ? role : nil)
    }
}

extension SessionConfig.Tool {
    /// The estimate-based highlight, ready to add to ``SessionConfig/tools``.
    /// Unlike the other two screen renderers it needs no
    /// ``screenLocate(capture:)`` slot behind it — the model brings its own
    /// coordinates — so a host that only wants to point can declare this alone.
    ///
    /// Report ``ScreenHighlightOutcome/landedOnControl`` only when you resolved
    /// the model's box to a real control; ``ScreenHighlightOutcome/landedOnEstimate``
    /// is what tells it to locate properly instead of trusting the estimate.
    public static func screenHighlightBox(
        onHighlight: @escaping @Sendable (ScreenHighlightBoxRequest) async throws -> ScreenHighlightOutcome
    ) -> SessionConfig.Tool {
        .sdkClient(SDKClientTool(
            name: ScreenHighlightBoxTool.name,
            description: ScreenHighlightBoxTool.toolDescription,
            parameters: sdkToolParameters(fromJSON: ScreenHighlightBoxTool.parametersJSON),
            handler: { args in
                guard let request = ScreenHighlightBoxTool.request(from: args) else {
                    throw ScreenToolError(
                        message: "\(ScreenHighlightBoxTool.name): pass x, y, width and height as "
                            + "fractions of the shared surface, plus a label"
                    )
                }
                return try await onHighlight(request).toolResult
            }
        ))
    }
}
