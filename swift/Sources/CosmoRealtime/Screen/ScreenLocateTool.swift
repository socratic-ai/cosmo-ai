import Foundation

/// The unadvertised half of the screen surface: the host's answer to "show me
/// the screen". `cosmo_screen_locate` drives it over RPC — the model never
/// picks it from a tool list — and the SDK keeps every snapshot it yields in a
/// short-TTL cache, so the handle the locator mints against that snapshot still
/// resolves when the model passes it to a renderer.
///
/// Declaring it is what turns the locator on: a config carrying one emits
/// `{kind: "screen_locate"}` and the server offers `cosmo_screen_locate` for
/// the session. There is no public initializer — construct it through
/// ``AgentTool/screenLocate(capture:)``.
public final class ScreenLocateTool: @unchecked Sendable {
    /// Server→client RPC method the locator calls; a rename is a wire break.
    public static let rpcMethod = "screen_capture"

    /// Byte-stream topic the capture payload is published on. Matches the
    /// backend's ``SCREEN_CAPTURE_TOPIC``.
    public static let byteStreamTopic = "screen_capture"

    /// AX descriptor budgets, matching the backend's `AXElement`. A descriptor
    /// is a *name* for a click target, so anything longer is a document that
    /// the screenshot already shows; `value` is content rather than identity
    /// and is held tighter. The backend clamps too — capping here keeps the
    /// bytes off the wire rather than guarding validation.
    static let roleMaxChars = 64
    static let labelMaxChars = 512
    static let valueMaxChars = 256

    /// Snapshot the current screen. Throw ``ScreenCaptureUnavailable`` to
    /// decline benignly; any other throw is an unexpected failure.
    public typealias Handler = @Sendable () async throws -> ScreenCapture

    /// ``Handler`` told what the caller will actually read, so a host can skip
    /// building its element list for a pixels-only capture.
    public typealias RequestHandler = @Sendable (ScreenCaptureRequest) async throws ->
        ScreenCapture

    private let onCapture: RequestHandler
    private let cache: ScreenCaptureCache

    private let lock = NSLock()
    private var publish: (@Sendable (Data, String) async throws -> Void)?

    init(cache: ScreenCaptureCache, onCapture: @escaping RequestHandler) {
        self.cache = cache
        self.onCapture = onCapture
    }

    /// Bind the byte-stream publish to the live session. Set once, right after
    /// the transport comes up — the payload can only fire once the locator
    /// calls, well after connect, so the late bind never races.
    func bindPublish(_ publish: @escaping @Sendable (Data, String) async throws -> Void) {
        lock.lock(); self.publish = publish; lock.unlock()
    }

    /// The capture RPC as a handler, registered by wire method name without
    /// being advertised.
    func handler() -> ClientToolHandler {
        { [self] args in try await run(args) }
    }

    private func run(_ args: [String: JSONValue]) async throws -> [String: JSONValue] {
        guard let captureID = args["capture_id"]?.stringValue, !captureID.isEmpty else {
            throw ScreenToolError(message: "\(Self.rpcMethod): missing required 'capture_id'")
        }
        // Absent means a server older than the hint, which only ever wanted both.
        let wantsElements = args["want_elements"]?.boolValue ?? true
        let capture: ScreenCapture
        do {
            capture = try await onCapture(ScreenCaptureRequest(wantsElements: wantsElements))
        } catch let unavailable as ScreenCaptureUnavailable {
            return ["captured": .bool(false), "message": .string(unavailable.message)]
        }
        cache.put(captureID, capture)
        let payload = try Self.encodePayload(
            captureID: captureID, capture: capture, includeElements: wantsElements
        )
        lock.lock(); let publish = self.publish; lock.unlock()
        guard let publish else {
            throw ScreenToolError(message: "\(Self.rpcMethod): byte-stream publish not bound")
        }
        do {
            try await publish(payload, Self.byteStreamTopic)
        } catch {
            throw ScreenToolError(
                message: "\(Self.rpcMethod): failed to publish capture stream: \(error.localizedDescription)"
            )
        }
        return ["captured": .bool(true)]
    }

    static func clamp(_ text: String, to limit: Int) -> String {
        text.count > limit ? String(text.prefix(limit)) : text
    }

    private static func names(_ descriptor: String?) -> Bool {
        guard let descriptor else { return false }
        return !descriptor.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// JSON byte-stream payload the locator's ``ScreenCapturePayload``
    /// parses: `{capture_id, image_b64, mime_type, ax_elements}`. The server
    /// also accepts `elements`; this SDK keeps the old spelling until every
    /// deployed backend has shipped the one that reads both.
    static func encodePayload(
        captureID: String, capture: ScreenCapture, includeElements: Bool = true
    ) throws -> Data {
        struct AXElementPayload: Encodable {
            let idx: Int
            let role: String
            let title: String?
            let label: String?
            let value: String?
            let frame: [Double]  // [x, y, w, h] in screen points
        }
        struct Payload: Encodable {
            let capture_id: String
            let image_b64: String
            let mime_type: String
            let ax_elements: [AXElementPayload]
        }
        let ax = (includeElements ? capture.elements : []).map { el -> AXElementPayload in
            let title = el.title.map { clamp($0, to: labelMaxChars) }
            let label = el.label.map { clamp($0, to: labelMaxChars) }
            // Carried only where it is the element's sole name: the grounder
            // reads the screenshot, so a named element's content is a second
            // copy of pixels it can already see. A blank descriptor names
            // nothing.
            let named = names(title) || names(label)
            let value = named ? nil : el.value.map { clamp($0, to: valueMaxChars) }
            return AXElementPayload(
                idx: el.index,
                role: clamp(el.role, to: roleMaxChars),
                title: title,
                label: label,
                value: value,
                frame: [
                    Double(el.frame.origin.x),
                    Double(el.frame.origin.y),
                    Double(el.frame.size.width),
                    Double(el.frame.size.height),
                ]
            )
        }
        return try JSONEncoder().encode(
            Payload(
                capture_id: captureID,
                image_b64: capture.imageJPEG.base64EncodedString(),
                mime_type: "image/jpeg",
                ax_elements: ax
            )
        )
    }
}

extension AgentTool {
    /// The screen the agent may look at, ready to add to ``RealtimeAgent/tools``
    /// alongside the renderers that act on what it finds:
    ///
    /// ```swift
    /// tools: [
    ///     .screenLocate { try await screenshotAndAccessibilityList() },
    ///     .screenClickElement { request in … },
    ///     .screenHighlightElement { request in … },
    /// ]
    /// ```
    ///
    /// Unlike every other tool here it is never advertised: the model cannot
    /// call it, `cosmo_screen_locate` does. Declaring it is what asks for the
    /// locator, and the SDK owns everything wire-facing behind it — the capture
    /// cache, the payload encoding, the byte-stream publish, and the ack.
    /// Your handler owns only the snapshot; throw
    /// ``ScreenCaptureUnavailable`` to decline one benignly.
    public static func screenLocate(
        capture: @escaping ScreenLocateTool.Handler
    ) -> AgentTool {
        screenLocate(cache: .shared) { _ in try await capture() }
    }

    /// The screen tool, with the capture handler told what the caller will read
    /// — see ``ScreenCaptureRequest``. Skipping the element walk when
    /// ``ScreenCaptureRequest/wantsElements`` is false is what makes a
    /// pixels-only capture fast; everything else matches
    /// ``screenLocate(capture:)``.
    public static func screenLocate(
        capture: @escaping ScreenLocateTool.RequestHandler
    ) -> AgentTool {
        screenLocate(cache: .shared, capture: capture)
    }

    /// Cache-injecting variant so tests can drive the pairing on their own clock.
    static func screenLocate(
        cache: ScreenCaptureCache,
        capture: @escaping ScreenLocateTool.RequestHandler
    ) -> AgentTool {
        .screenLocate(ScreenLocateTool(cache: cache, onCapture: capture))
    }

    static func screenLocate(
        cache: ScreenCaptureCache,
        capture: @escaping ScreenLocateTool.Handler
    ) -> AgentTool {
        screenLocate(cache: cache) { _ in try await capture() }
    }
}
