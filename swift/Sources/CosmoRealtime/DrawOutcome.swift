import Foundation

/// What a renderer tool's handler reports back to the model.
///
/// Drawing can fail for reasons the model must hear about — the camera is
/// off, the preview isn't on screen, the frame the box describes is already
/// gone. Answering "shown" regardless would tell the model something is on
/// the user's screen when nothing is, and it would keep talking as if the
/// user could see it. The reason travels with the refusal so the model can
/// say something useful instead of guessing.
public struct DrawOutcome: Sendable, Equatable {
    /// The annotation is on screen.
    public static let shown = DrawOutcome(shown: true, reason: nil)

    /// Nothing was drawn. ``reason`` is model-facing: it is what the agent
    /// tells the user, so write it as an instruction ("the camera is off —
    /// ask the user to turn it on"), not as an error code.
    public static func notShown(_ reason: String) -> DrawOutcome {
        DrawOutcome(shown: false, reason: reason)
    }

    public let shown: Bool
    public let reason: String?

    private init(shown: Bool, reason: String?) {
        self.shown = shown
        self.reason = reason
    }

    /// The tool result the model receives.
    var toolResult: [String: JSONValue] {
        var result: [String: JSONValue] = ["shown": .bool(shown)]
        if let reason { result["reason"] = .string(reason) }
        return result
    }
}
