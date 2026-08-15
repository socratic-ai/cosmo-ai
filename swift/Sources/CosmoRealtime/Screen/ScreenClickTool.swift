import Foundation

/// Decoded `cosmo_sdk_screen_click_element` arguments, before the handle is
/// resolved: the `found_element` the model passed back, and how to click it.
struct ScreenClickArgs: Sendable, Equatable {
    var foundElement: String
    var action: ScreenAction
}

/// What a click handler is asked to do: the element the handle resolved to, the
/// capture it was located in (a host re-reads ``ScreenCapture/context`` from it
/// to check the screen hasn't moved on), and the click to perform.
public struct ScreenClickRequest: Sendable {
    public let element: ScreenElement
    public let capture: ScreenCapture
    public let action: ScreenAction

    public init(element: ScreenElement, capture: ScreenCapture, action: ScreenAction) {
        self.element = element
        self.capture = capture
        self.action = action
    }
}

/// What a ``SessionConfig/Tool/screenClickElement(onClick:)`` handler reports
/// back to the model.
///
/// Clicking can fail for reasons the model must hear about — the user switched
/// apps, the window scrolled, the call ended. Answering "clicked" regardless
/// would have it narrate something that never happened. The reason travels with
/// the refusal so it can say something useful instead of guessing.
public struct ScreenClickOutcome: Sendable, Equatable {
    /// The click landed.
    public static let clicked = ScreenClickOutcome(clicked: true, reason: nil)

    /// Nothing was clicked. ``reason`` is model-facing: it is what the agent
    /// tells the user, so write it as an instruction ("the window moved —
    /// locate it again"), not as an error code.
    public static func notClicked(_ reason: String) -> ScreenClickOutcome {
        ScreenClickOutcome(clicked: false, reason: reason)
    }

    public let clicked: Bool
    public let reason: String?

    private init(clicked: Bool, reason: String?) {
        self.clicked = clicked
        self.reason = reason
    }

    /// The tool result the model receives.
    var toolResult: [String: JSONValue] {
        var result: [String: JSONValue] = ["clicked": .bool(clicked)]
        if let reason { result["reason"] = .string(reason) }
        return result
    }
}

/// `cosmo_sdk_screen_click_element` — the acting half of the locate-then-act
/// pair. `cosmo_screen_locate` captures the shared screen, resolves the model's
/// description against it, and returns candidates each carrying a
/// `found_element` handle; the model picks the one it meant and passes that
/// handle here.
///
/// It locates nothing — it carries the model's choice to the host, which owns
/// the click itself. The SDK owns the contract (declaration, typed decode, and
/// resolving the handle back to the element it names).
public enum ScreenClickTool {
    /// Wire name shipped in `tool-invocation` events; a rename is a wire break.
    /// Matches the backend regex `^[a-z][a-z0-9_]{2,63}$` (`client_declared.py`).
    public static let name = "cosmo_sdk_screen_click_element"

    /// Tool-group key for backend telemetry + brain-allowlisting.
    public static let group = "screen"

    public static var toolDescription: String {
        """
        Click an element on the shared screen. Takes a found_element handle from \
        cosmo_screen_locate — pass one back exactly as you received it, never one you \
        assembled yourself.
        """
    }

    /// Args JSON-schema in the backend's restricted dialect.
    public static var parametersJSON: String {
        #"""
        {"type":"object","properties":{"found_element":{"type":"string","description":"A found_element handle exactly as cosmo_screen_locate returned it."},"button":{"type":"string","enum":["left","right"],"description":"'right' opens context menus."},"double":{"type":"boolean","description":"True for a double-click (open a file, select a word)."}},"required":["found_element"]}
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

    /// Decode a `cosmo_sdk_screen_click_element` invocation's arguments. Returns
    /// `nil` when the handle is absent, or the button is one this SDK has no
    /// gesture for — unlike a highlight's glyph, an unrecognized button has no
    /// harmless fallback, since guessing which button to press is guessing what
    /// happens to the user's machine.
    ///
    /// The handle itself is not inspected here: it is opaque, so a token the
    /// model assembled is a miss against the cache rather than a decode error,
    /// and the model is told to locate again rather than handed a complaint.
    static func args(from args: [String: JSONValue]) -> ScreenClickArgs? {
        guard let handle = args["found_element"]?.stringValue, !handle.isEmpty else { return nil }
        let button: ScreenButton
        if let raw = args["button"]?.stringValue {
            guard let parsed = ScreenButton(rawValue: raw) else { return nil }
            button = parsed
        } else {
            button = .left
        }
        return ScreenClickArgs(
            foundElement: handle,
            action: ScreenAction(button: button, double: args["double"]?.boolValue ?? false)
        )
    }
}

extension SessionConfig.Tool {
    /// The click renderer, ready to add to ``SessionConfig/tools`` alongside the
    /// ``screenLocate(capture:)`` slot that feeds it:
    ///
    /// ```swift
    /// tools: [.screenLocate { … }, .screenClickElement { request in
    ///     guard stillFocused(request.capture) else {
    ///         return .notClicked("the foreground app changed — locate it again")
    ///     }
    ///     try press(request.element.frame, request.action)
    ///     return .clicked
    /// }]
    /// ```
    ///
    /// The SDK decodes the arguments and resolves the model's handle back to the
    /// element it names; your handler owns the click and the honest answer
    /// about whether it landed. A handle that no longer resolves — a capture the
    /// session never took, or one older than ``ScreenCaptureCache/maxAge`` —
    /// declines before reaching your code, since acting on a snapshot the SDK
    /// cannot produce would be acting blind.
    public static func screenClickElement(
        onClick: @escaping @Sendable (ScreenClickRequest) async throws -> ScreenClickOutcome
    ) -> SessionConfig.Tool {
        screenClickElement(cache: .shared, onClick: onClick)
    }

    /// Cache-injecting variant so tests can drive the pairing on their own clock.
    static func screenClickElement(
        cache: ScreenCaptureCache,
        onClick: @escaping @Sendable (ScreenClickRequest) async throws -> ScreenClickOutcome
    ) -> SessionConfig.Tool {
        .sdkClient(SDKClientTool(
            name: ScreenClickTool.name,
            description: ScreenClickTool.toolDescription,
            parameters: sdkToolParameters(fromJSON: ScreenClickTool.parametersJSON),
            handler: { args in
                guard let parsed = ScreenClickTool.args(from: args) else {
                    throw ScreenToolError(
                        message: "\(ScreenClickTool.name): pass found_element exactly as "
                            + "cosmo_screen_locate returned it, and button left|right"
                    )
                }
                guard let resolved = cache.resolve(parsed.foundElement) else {
                    return ScreenClickOutcome.notClicked(unresolvableHandleReason).toolResult
                }
                let request = ScreenClickRequest(
                    element: resolved.element,
                    capture: resolved.capture,
                    action: parsed.action
                )
                return try await onClick(request).toolResult
            }
        ))
    }
}
