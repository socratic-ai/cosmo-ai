import Foundation

/// The client-tool RPC reply contract: the `{ok, result, error}` envelope and
/// the transport's ceiling on its serialized size. Public so a tool pack can
/// bound its replies against the values the transport enforces instead of
/// copying them.
public enum ClientToolReply {
    /// Ceiling on one serialized reply envelope. The transport shortens a
    /// reply that would exceed it — error text, an ack note, or a success
    /// result — rather than dropping it.
    public static let maxBytes = 15 * 1024

    /// Terminates every string the transport shortened to fit ``maxBytes``.
    public static let truncationSuffix = "… [truncated]"

    /// Added to the top-level result object of a success reply the transport
    /// had to shorten. Its value is `{note, kept_bytes, original_bytes}` —
    /// ``truncationMarkerNote`` plus the serialized size of the result that
    /// shipped and of the one the handler returned. Under the
    /// ``SessionConfig/sdkToolNamePrefix`` namespace, so it cannot collide
    /// with a key of the caller's own.
    public static let truncationMarkerKey = "cosmo_sdk_truncated"

    /// The instruction the model reads when a result was shortened. Phrased
    /// as a directive rather than a description, and it names no recovery
    /// mechanism a given tool might not have — a tool that takes no arguments
    /// cannot be asked a narrower question, so the always-available fallback
    /// is to say what is missing.
    public static let truncationMarkerNote =
        "partial result — do not answer as if it were complete; "
        + "narrow the request or say what is missing."

    /// The `{ok, result, error}` envelope, serialized to JSON. Does not
    /// itself enforce ``maxBytes``; the dispatcher does, on the way out. A
    /// tool pack that can shorten its own payload meaningfully — dropping
    /// whole hits, keeping the tail of a log — should still do so, because
    /// the generic shortening cannot know which bytes mattered.
    public static func envelope(
        ok: Bool, result: [String: JSONValue]? = nil, error: String? = nil
    ) -> String {
        guard let data = try? JSONEncoder().encode(object(ok: ok, result: result, error: error))
        else {
            return #"{"ok":false,"result":null,"error":"reply encode failed"}"#
        }
        return String(decoding: data, as: UTF8.self)
    }

    /// A reply string returned through the string-based RPC dispatcher
    /// (``ClientToolRPCHandler``) is decoded and re-wrapped as the `result`
    /// of a fresh `{ok: true}` envelope, and the transport enforces
    /// ``maxBytes`` on that outer form. The serialized size of that outer
    /// envelope for a reply built from these parts — bound dispatcher
    /// replies against this, not against the inner envelope's own size.
    public static func rewrappedSize(
        ok: Bool, result: [String: JSONValue]? = nil, error: String? = nil
    ) -> Int {
        envelope(ok: true, result: object(ok: ok, result: result, error: error)).utf8.count
    }

    private static func object(
        ok: Bool, result: [String: JSONValue]?, error: String?
    ) -> [String: JSONValue] {
        [
            "ok": .bool(ok),
            "result": result.map(JSONValue.object) ?? .null,
            "error": error.map(JSONValue.string) ?? .null,
        ]
    }
}
