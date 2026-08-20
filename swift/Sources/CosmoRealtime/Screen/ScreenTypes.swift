import CoreGraphics
import Foundation
import OSLog

/// The capture an element was found in and its index there, split back out of
/// a `found_element` handle. Internal: a renderer's handler is given the
/// resolved ``ScreenElement``, never the token's parts, so nothing downstream
/// can address an element the locator did not pick.
struct FoundElement: Sendable, Equatable {
    let captureID: String
    let elementIndex: Int
}

/// The `found_element` handle `cosmo_screen_locate` mints and a renderer
/// spends. Opaque to the model — it passes one along, it never builds one.
///
/// The format is a two-party contract with the backend's
/// `encode_found_element`, pinned by `sdk-client-tool-vectors.json`
/// (`foundElement`). It has to be pinned: an unresolvable handle is a benign
/// decline by design, so a separator that disagreed with the backend would
/// degrade into a session where every renderer quietly declines and the model
/// re-locates forever, failing nothing.
public enum FoundElementHandle {
    static let separator: Character = "#"

    /// Mint a handle the way the backend does. The SDK never calls this in
    /// production — the locator is the only minter — but the format lives in
    /// code so both sides can be checked against the same vectors.
    static func encode(captureID: String, elementIndex: Int) -> String {
        "\(captureID)\(separator)\(elementIndex)"
    }

    /// Split a handle into its parts; `nil` when it is not one this SDK minted
    /// the shape of. The rightmost separator binds, so a capture id containing
    /// one survives the round trip.
    static func decode(_ handle: String) -> FoundElement? {
        guard let cut = handle.lastIndex(of: separator) else { return nil }
        let captureID = String(handle[handle.startIndex..<cut])
        let index = handle[handle.index(after: cut)...]
        guard !captureID.isEmpty, !index.isEmpty,
              index.allSatisfy(\.isASCII), index.allSatisfy(\.isNumber),
              let elementIndex = Int(index)
        else { return nil }
        return FoundElement(captureID: captureID, elementIndex: elementIndex)
    }
}

/// Which mouse button a click uses. `right` is the context-menu button.
public enum ScreenButton: String, Sendable, CaseIterable {
    case left
    case right
}

/// How to click the located element: which button, and whether it's a double.
/// The wire distinguishes only single vs double, so `double` is a bool.
public struct ScreenAction: Sendable, Equatable {
    public let button: ScreenButton
    public let double: Bool

    public init(button: ScreenButton = .left, double: Bool = false) {
        self.button = button
        self.double = double
    }
}

/// Which side of the target the tooltip sits on. `auto` picks the side with
/// the most room.
public enum ScreenPlacement: String, Sendable, CaseIterable {
    case auto, top, bottom, left, right
}

/// Which affordance to draw on a highlight, matched to the action being asked
/// of the user. Describes the glyph only — a highlight never acts (see
/// ``ScreenAction`` for that).
public enum ScreenAffordance: String, Sendable, CaseIterable {
    case pointer
    case click
    case doubleClick = "double_click"
    case leftClick = "left_click"
    case rightClick = "right_click"
    case dragShow = "drag_show"
    case pressHold = "press_hold"
    case inform
}

/// A rectangle the caller located itself, as fractions of the shared surface
/// — the shared window's live bounds when a window is shared, else the
/// display: `x`/`y` are the top-left corner (0 = left/top edge), all four in
/// `0...1`.
///
/// Deliberately not a ``CGRect``: ``ScreenElement/frame`` is also a rectangle
/// but in screen points, and the two spaces are not interchangeable. A distinct
/// type makes mixing them a compile error rather than a highlight drawn in the
/// top-left one percent of the screen.
public struct ScreenBox: Sendable, Equatable {
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }
}

/// What the caller believes the target is *called*, alongside where it thinks
/// it is. A host with a platform accessibility tree can ask the OS for that
/// control's exact frame — a far better answer than any estimate — and one
/// without a usable tree ignores this and falls back to the box.
///
/// ``title`` is the control's own visible text ("Files changed"), not the
/// tooltip the highlight displays; those are different strings and the tooltip
/// travels separately as `label`.
public struct ScreenElementHint: Sendable, Equatable {
    public let title: String
    /// Platform role to disambiguate a title that appears more than once
    /// (e.g. `"AXButton"`). `nil` matches on title alone.
    public let role: String?

    public init(title: String, role: String? = nil) {
        self.title = title
        self.role = role
    }
}

/// One interactive on-screen element the locator may select. `index` is
/// 0-based and contiguous within one ``ScreenCapture``; `frame` is in screen
/// points (top-left origin) so a host can act on its center.
public struct ScreenElement: Sendable {
    public let index: Int
    public let role: String
    public let title: String?
    public let label: String?
    public let value: String?
    public let frame: CGRect

    public init(
        index: Int,
        role: String,
        title: String?,
        label: String?,
        value: String?,
        frame: CGRect
    ) {
        self.index = index
        self.role = role
        self.title = title
        self.label = label
        self.value = value
        self.frame = frame
    }
}

/// Opaque per-capture state a host stashes at capture time and reads back at
/// action time to validate freshness before it acts. The SDK never inspects
/// it; the platform host defines what "still fresh" means.
public struct ScreenCaptureContext: Sendable {
    /// Frontmost app PID at capture time — a host may re-check it before
    /// acting so a stale handle can't land in a window the user switched to.
    public let appPID: pid_t?
    /// Focused-window frame (top-left global points); nil when unavailable.
    public let windowFrame: CGRect?

    public init(appPID: pid_t?, windowFrame: CGRect?) {
        self.appPID = appPID
        self.windowFrame = windowFrame
    }
}

/// A snapshot the locator works from: the image plus the pickable elements,
/// plus the freshness context the host reads back at action time.
public struct ScreenCapture: Sendable {
    public let imageJPEG: Data
    public let elements: [ScreenElement]
    public let context: ScreenCaptureContext

    public init(imageJPEG: Data, elements: [ScreenElement], context: ScreenCaptureContext) {
        self.imageJPEG = imageJPEG
        self.elements = elements
        self.context = context
    }
}

/// What the server wants out of this capture. The accessibility walk is the
/// expensive half and only the grounding locator reads it, so a handler that
/// can skip it when `wantsElements` is false answers materially faster.
/// Ignoring the flag is always correct — the extra elements are dropped.
public struct ScreenCaptureRequest: Sendable, Equatable {
    /// Whether the caller will use ``ScreenCapture/elements``.
    public let wantsElements: Bool

    public init(wantsElements: Bool) {
        self.wantsElements = wantsElements
    }
}

/// Thrown by a ``AgentTool/screenLocate(capture:)`` handler when the
/// screen can't be captured for a benign reason (call ended, sharing off). The
/// SDK maps it to `captured:false` + the message; any other error surfaces as a
/// tool error.
public struct ScreenCaptureUnavailable: Error, Sendable {
    public let message: String
    public init(message: String) {
        self.message = message
    }
}

/// An unexpected failure servicing a screen tool (missing/invalid args,
/// byte-stream publish failure). Surfaces as an `{ok:false,error}` envelope via
/// ``ClientToolDispatch``; a handle that no longer resolves is a benign decline
/// (`clicked:false` / `shown:false`) rather than one of these.
struct ScreenToolError: Error, LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

// MARK: - Capture cache

/// Short-TTL cache pairing a capture with the renderer call that follows it:
/// `cosmo_screen_locate` drives the capture RPC, grounds the model's
/// description against the streamed screenshot + AX list, and mints handles; a
/// renderer resolves one here against the *same* snapshot. Keyed by capture id
/// (capped at ``maxEntries``) so concurrent captures don't evict each other.
public final class ScreenCaptureCache: @unchecked Sendable {
    /// Every screen tool a host wires shares this one, which is what lets a
    /// handle minted during ``AgentTool/screenLocate(capture:)`` resolve
    /// inside a renderer declared separately. Capture ids are server-minted per
    /// capture, so entries never collide; ``maxAge`` and ``maxEntries`` bound it.
    public static let shared = ScreenCaptureCache()

    static let log = Logger(subsystem: CosmoRealtimeLog.subsystem, category: "screen")

    /// A click against an older capture is grounded on a screen the user has
    /// likely scrolled or navigated away from.
    public static let maxAge: TimeInterval = 30
    /// More than enough for the few captures that can be in flight at once.
    public static let maxEntries = 4

    private struct Entry {
        let capture: ScreenCapture
        let createdAt: Date
    }

    private let lock = NSLock()
    private var entries: [String: Entry] = [:]
    private let clock: @Sendable () -> Date

    /// ``now`` injects the clock for tests; production uses the wall clock.
    public init(now: @escaping @Sendable () -> Date = { Date() }) {
        self.clock = now
    }

    public func put(_ captureID: String, _ capture: ScreenCapture, now: Date? = nil) {
        let now = now ?? clock()
        lock.lock(); defer { lock.unlock() }
        entries = entries.filter { now.timeIntervalSince($0.value.createdAt) <= Self.maxAge }
        entries[captureID] = Entry(capture: capture, createdAt: now)
        while entries.count > Self.maxEntries {
            guard let oldest = entries.min(by: { $0.value.createdAt < $1.value.createdAt }) else { break }
            entries.removeValue(forKey: oldest.key)
        }
    }

    /// The capture for ``captureID`` if present and not older than ``maxAge``.
    public func get(_ captureID: String, now: Date? = nil) -> ScreenCapture? {
        let now = now ?? clock()
        lock.lock(); defer { lock.unlock() }
        guard let entry = entries[captureID] else { return nil }
        guard now.timeIntervalSince(entry.createdAt) <= Self.maxAge else { return nil }
        return entry.capture
    }

    /// The element a handle names, with the capture it was found in. `nil` for
    /// any unresolvable handle — a token that does not parse, an unknown capture
    /// id, an expired entry, or an index past the elements that capture carried.
    ///
    /// A token that does not parse is the same miss to the model but not the
    /// same event: the locator only ever mints well-formed handles, so it means
    /// either this SDK drifted from the backend's encoder or the model invented
    /// one. Neither can throw — a fabricated handle is model output, not a
    /// broken invariant — so it is logged instead.
    func resolve(
        _ foundElement: String,
        now: Date? = nil
    ) -> (element: ScreenElement, capture: ScreenCapture)? {
        guard let parts = FoundElementHandle.decode(foundElement) else {
            Self.log.warning(
                "unparseable found_element handle: \(foundElement, privacy: .public)"
            )
            return nil
        }
        guard let capture = get(parts.captureID, now: now) else { return nil }
        guard capture.elements.indices.contains(parts.elementIndex) else { return nil }
        return (capture.elements[parts.elementIndex], capture)
    }

    public func clear() {
        lock.lock(); defer { lock.unlock() }
        entries = [:]
    }
}

// MARK: - JSONValue conveniences (internal to the SDK)

extension JSONValue {
    var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    var intValue: Int? {
        switch self {
        case .int(let i): return i
        case .double(let d) where d == d.rounded(): return Int(d)
        default: return nil
        }
    }

    var boolValue: Bool? {
        if case .bool(let b) = self { return b }
        return nil
    }

    var doubleValue: Double? {
        switch self {
        case .double(let d): return d
        case .int(let i): return Double(i)
        default: return nil
        }
    }
}

/// Model-facing: a handle the cache can no longer resolve is a benign decline,
/// not an error — the model's move is to locate again, not to retry.
let unresolvableHandleReason =
    "that found_element is no longer valid — call cosmo_screen_locate again for a fresh one"

// MARK: - Shared arg decoding

enum ScreenArgs {
    /// Unknown placement/affordance values fall back rather than reject: they
    /// mean the caller is newer than this SDK, and a highlight with the wrong
    /// glyph still points the user at the right control, whereas a rejection
    /// points them at nothing.
    static func placement(_ args: [String: JSONValue]) -> ScreenPlacement {
        guard let raw = args["placement"]?.stringValue else { return .auto }
        return ScreenPlacement(rawValue: raw) ?? .auto
    }

    /// Wire name is `interaction`; the Swift parameter is `affordance` to keep
    /// it distinct from ``ScreenAction``, which is what a click actually does.
    static func affordance(_ args: [String: JSONValue]) -> ScreenAffordance {
        guard let raw = args["interaction"]?.stringValue else { return .click }
        return ScreenAffordance(rawValue: raw) ?? .click
    }

    static func clamp01(_ value: Double) -> Double { min(1, max(0, value)) }
}
