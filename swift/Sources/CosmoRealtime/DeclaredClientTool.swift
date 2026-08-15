import Foundation

/// One client-executed tool self-described to the backend at session start
/// (`RealtimeClientInit.declared_tools`). The backend materializes a
/// session-scoped tool definition from this, so a new client tool ships with
/// a client release alone — no per-tool backend code or deploy. See
/// `docs/realtime/client-declared-tools-design.md`.
///
/// Declarations the server refuses (sanitization, caps, name collisions)
/// are echoed on `RealtimeServerReady.rejected_tools` with a reason.
public struct DeclaredClientTool: Sendable, Equatable {
    public var name: String
    public var description: String
    /// JSON-schema object for the tool's arguments, as JSON text. The server
    /// accepts the restricted dialect of backend `client_declared.py`:
    /// `type/properties/required/items/enum/description/anyOf/default/
    /// maxLength/minLength/maximum/minimum`, top-level `type: "object"`.
    public var parametersJSON: String
    /// Tool-group key for server telemetry (e.g. `"tmux"`, `"files"`).
    public var group: String?

    public init(
        name: String,
        description: String,
        parametersJSON: String,
        group: String? = nil
    ) {
        self.name = name
        self.description = description
        self.parametersJSON = parametersJSON
        self.group = group
    }
}
