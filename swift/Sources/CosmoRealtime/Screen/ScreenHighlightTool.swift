import Foundation

/// Decoded `cosmo_sdk_screen_highlight_element` arguments, before the handle is
/// resolved: the `found_element` the model passed back, plus the tooltip to
/// show beside it.
struct ScreenHighlightArgs: Sendable, Equatable {
    var foundElement: String
    var label: String
    var placement: ScreenPlacement
    var interaction: ScreenAffordance
}

/// What a highlight handler is asked to do: the element the handle resolved to
/// and the capture it was located in, plus the tooltip to draw beside it.
public struct ScreenHighlightRequest: Sendable {
    public let element: ScreenElement
    public let capture: ScreenCapture
    public let label: String
    public let placement: ScreenPlacement
    public let interaction: ScreenAffordance

    public init(
        element: ScreenElement,
        capture: ScreenCapture,
        label: String,
        placement: ScreenPlacement,
        interaction: ScreenAffordance
    ) {
        self.element = element
        self.capture = capture
        self.label = label
        self.placement = placement
        self.interaction = interaction
    }
}

/// `cosmo_sdk_screen_highlight_element` — the pointing sibling of
/// ``ScreenClickTool``, fed by the same `cosmo_screen_locate` handles. It marks
/// the control and stops there, so the user does the acting.
///
/// It answers in the ``ScreenHighlightOutcome`` it shares with
/// ``ScreenHighlightBoxTool``, so the model reads one reply shape whichever it
/// called. Here `exact` is always true: a handle names an element the locator
/// picked out of a real accessibility list, so there is nothing left to be
/// imprecise about — only the box highlight can answer
/// ``ScreenHighlightOutcome/landedOnEstimate``.
public enum ScreenHighlightTool {
    /// Wire name shipped in `tool-invocation` events; a rename is a wire break.
    /// Matches the backend regex `^[a-z][a-z0-9_]{2,63}$` (`client_declared.py`).
    public static let name = "cosmo_sdk_screen_highlight_element"

    /// Tool-group key for backend telemetry + brain-allowlisting.
    public static let group = "screen"

    public static var toolDescription: String {
        """
        Highlight an element on the shared screen — point at it without acting on it. \
        Takes a found_element handle from cosmo_screen_locate; pass one back exactly as \
        you received it. Visual only: it never clicks.
        """
    }

    /// Args JSON-schema in the backend's restricted dialect.
    public static var parametersJSON: String {
        #"""
        {"type":"object","properties":{"found_element":{"type":"string","description":"A found_element handle exactly as cosmo_screen_locate returned it."},"label":{"type":"string","maxLength":80,"description":"Tooltip text shown beside the highlight."},"placement":{"type":"string","enum":["auto","top","bottom","left","right"],"description":"Which side of the target the tooltip sits on."},"interaction":{"type":"string","enum":["pointer","click","double_click","left_click","right_click","drag_show","press_hold","inform"],"description":"Which glyph the highlight draws — the action being asked of the user."}},"required":["found_element","label"]}
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

    /// Decode a `cosmo_sdk_screen_highlight_element` invocation's arguments.
    /// Returns `nil` when the handle or the tooltip is absent or malformed; an
    /// unrecognized placement or glyph falls back instead, since a highlight
    /// drawn with the wrong glyph still points at the right control.
    static func args(from args: [String: JSONValue]) -> ScreenHighlightArgs? {
        guard let handle = args["found_element"]?.stringValue, !handle.isEmpty else { return nil }
        guard let label = args["label"]?.stringValue else { return nil }
        return ScreenHighlightArgs(
            foundElement: handle,
            label: label,
            placement: ScreenArgs.placement(args),
            interaction: ScreenArgs.affordance(args)
        )
    }
}

extension SessionConfig.Tool {
    /// The element highlight, ready to add to ``SessionConfig/tools`` alongside
    /// the ``screenLocate(capture:)`` slot that feeds it. Same contract as
    /// ``screenClickElement(onClick:)`` — the SDK decodes and resolves the
    /// handle, your handler draws and answers honestly. A grounded handle is on
    /// a real control, so ``ScreenHighlightOutcome/landedOnControl`` is the
    /// answer here; the outcome is shared with
    /// ``screenHighlightBox(onHighlight:)`` so the model reads one reply shape.
    public static func screenHighlightElement(
        onHighlight: @escaping @Sendable (ScreenHighlightRequest) async throws -> ScreenHighlightOutcome
    ) -> SessionConfig.Tool {
        screenHighlightElement(cache: .shared, onHighlight: onHighlight)
    }

    /// Cache-injecting variant so tests can drive the pairing on their own clock.
    static func screenHighlightElement(
        cache: ScreenCaptureCache,
        onHighlight: @escaping @Sendable (ScreenHighlightRequest) async throws -> ScreenHighlightOutcome
    ) -> SessionConfig.Tool {
        .sdkClient(SDKClientTool(
            name: ScreenHighlightTool.name,
            description: ScreenHighlightTool.toolDescription,
            parameters: sdkToolParameters(fromJSON: ScreenHighlightTool.parametersJSON),
            handler: { args in
                guard let parsed = ScreenHighlightTool.args(from: args) else {
                    throw ScreenToolError(
                        message: "\(ScreenHighlightTool.name): pass found_element exactly as "
                            + "cosmo_screen_locate returned it, plus a label"
                    )
                }
                guard let resolved = cache.resolve(parsed.foundElement) else {
                    return ScreenHighlightOutcome.notShown(unresolvableHandleReason).toolResult
                }
                let request = ScreenHighlightRequest(
                    element: resolved.element,
                    capture: resolved.capture,
                    label: parsed.label,
                    placement: parsed.placement,
                    interaction: parsed.interaction
                )
                return try await onHighlight(request).toolResult
            }
        ))
    }
}
