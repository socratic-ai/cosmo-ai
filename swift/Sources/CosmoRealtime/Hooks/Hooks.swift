#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif
import Foundation
import os

// MARK: - Outcome + Permission

public enum ToolOutcome: Sendable, Equatable {
    case ok([String: JSONValue]?)
    case error(String)
    case denied(String)
}

public enum HookPermission: Sendable, Equatable {
    case allow
    case deny
}

// MARK: - Contexts

public struct SessionStartContext: Sendable {
    public let event: String = "SessionStart"

    public init() {}
}

public struct PreToolUseContext: Sendable {
    public let event: String = "PreToolUse"
    public let toolName: String
    public let arguments: [String: JSONValue]
    public let sessionId: String

    public init(toolName: String, arguments: [String: JSONValue], sessionId: String) {
        self.toolName = toolName
        self.arguments = arguments
        self.sessionId = sessionId
    }
}

public struct PostToolUseContext: Sendable {
    public let event: String = "PostToolUse"
    public let toolName: String
    public let arguments: [String: JSONValue]
    public let outcome: ToolOutcome
    public let sessionId: String

    public init(toolName: String, arguments: [String: JSONValue], outcome: ToolOutcome, sessionId: String) {
        self.toolName = toolName
        self.arguments = arguments
        self.outcome = outcome
        self.sessionId = sessionId
    }
}

/// Why a session reached its terminal state, as reported on
/// ``SessionEndContext``. Raw values are the cross-SDK reason slugs.
public enum DisconnectReason: String, Sendable, Equatable {
    case clientEnded = "client_ended"
    case clientClosed = "client_closed"
    case handshakeFailed = "handshake_failed"
    case serverEnded = "server_ended"
    case transportError = "transport_error"
}

public struct SessionEndContext: Sendable {
    public let event: String = "SessionEnd"
    public let reason: DisconnectReason
    public let detail: String?
    public let sessionId: String?

    public init(reason: DisconnectReason, detail: String?, sessionId: String?) {
        self.reason = reason
        self.detail = detail
        self.sessionId = sessionId
    }
}

// MARK: - Results

public struct SessionStartResult: Sendable {
    public let additionalContext: String?

    public init(additionalContext: String? = nil) {
        self.additionalContext = additionalContext
    }
}

public struct PreToolUseResult: Sendable {
    public let permission: HookPermission?
    public let reason: String?
    public let updatedArguments: [String: JSONValue]?

    public init(
        permission: HookPermission? = nil,
        reason: String? = nil,
        updatedArguments: [String: JSONValue]? = nil
    ) {
        self.permission = permission
        self.reason = reason
        self.updatedArguments = updatedArguments
    }
}

// MARK: - Hook typealiases

public typealias SessionStartHook = @Sendable (SessionStartContext) async throws -> SessionStartResult?
public typealias PreToolUseHook   = @Sendable (PreToolUseContext)   async throws -> PreToolUseResult?
public typealias PostToolUseHook  = @Sendable (PostToolUseContext)  async throws -> Void
public typealias SessionEndHook         = @Sendable (SessionEndContext)         async throws -> Void

// MARK: - Declared hooks + the seam factories

/// One declared hook for the agent's unified ``hooks: [Hook]`` list — an
/// in-process client hook built by a seam factory (list order is fold
/// order), or a declarative server hook the SERVER executes
/// (``Hook/server(_:)`` wrapping a ``SilenceTimeout``).
public struct Hook: Sendable {
    enum Callback: Sendable {
        case sessionStart(SessionStartHook)
        case preToolUse(matcher: String?, PreToolUseHook)
        case postToolUse(matcher: String?, PostToolUseHook)
        case sessionEnd(SessionEndHook)
        case server(SilenceTimeout)
    }

    let callback: Callback

    /// A declarative server hook: wire config the server executes even if
    /// this process dies mid-call.
    public static func server(_ hook: SilenceTimeout) -> Hook {
        Hook(callback: .server(hook))
    }
}

/// Declare a ``SessionStart`` hook — may return a ``SessionStartResult`` to
/// inject ``additionalContext`` into the instructions.
public func sessionStart(_ hook: @escaping SessionStartHook) -> Hook {
    Hook(callback: .sessionStart(hook))
}

/// Declare a ``PreToolUse`` hook — may deny or rewrite a local client-tool
/// call. ``matcher`` restricts it to matching tool names (glob grammar); a
/// malformed matcher throws here, not at session start.
public func preToolUse(matcher: String? = nil, _ hook: @escaping PreToolUseHook) throws -> Hook {
    if let matcher { try validateMatcher(matcher) }
    return Hook(callback: .preToolUse(matcher: matcher, hook))
}

/// Declare a ``PostToolUse`` observer, fired with the final ``ToolOutcome``
/// of each local client-tool call.
public func postToolUse(matcher: String? = nil, _ hook: @escaping PostToolUseHook) throws -> Hook {
    if let matcher { try validateMatcher(matcher) }
    return Hook(callback: .postToolUse(matcher: matcher, hook))
}

/// Declare a ``SessionEnd`` observer, fired exactly once at teardown.
public func sessionEnd(_ hook: @escaping SessionEndHook) -> Hook {
    Hook(callback: .sessionEnd(hook))
}

/// Split one unified list into the in-process client hooks (an engine) and
/// the server hooks (wire config).
func splitHooks(_ hooks: [Hook]) -> (engine: HookEngine?, server: [SilenceTimeout]) {
    var server: [SilenceTimeout] = []
    var client: [Hook] = []
    for hook in hooks {
        if case .server(let s) = hook.callback { server.append(s) } else { client.append(hook) }
    }
    return (client.isEmpty ? nil : HookEngine(client), server)
}

// MARK: - HookEngine

private let log = Logger(subsystem: CosmoRealtimeLog.subsystem, category: "hooks")

// Every hook event blocks a session seam (see the design doc's firing-seams
// section) — a hook slower than this is user-visible, so surface it.
private let slowHookWarnThreshold: Duration = .milliseconds(200)

private func warnIfSlow<R>(
    _ event: StaticString,
    tool: String? = nil,
    _ body: () async throws -> R
) async rethrows -> R {
    let start = ContinuousClock.now
    defer {
        let elapsed = ContinuousClock.now - start
        if elapsed >= slowHookWarnThreshold {
            let ms = Int((elapsed / .milliseconds(1)).rounded())
            log.warning("slow \(event, privacy: .public) hook: \(ms)ms tool=\(tool ?? "-", privacy: .public)")
        }
    }
    return try await body()
}

/// Dispatch engine over one agent's declared client hooks. Immutable —
/// built from the resolved ``Hook`` list; fold semantics are pinned by the
/// shared hook-engine vectors.
struct HookEngine: Sendable {
    private var sessionStart: [SessionStartHook] = []
    private var preToolUse: [(matcher: String?, hook: PreToolUseHook)] = []
    private var postToolUse: [(matcher: String?, hook: PostToolUseHook)] = []
    private var sessionEnd: [SessionEndHook] = []

    init(_ hooks: [Hook]) {
        for hook in hooks {
            switch hook.callback {
            case .sessionStart(let h): sessionStart.append(h)
            case .preToolUse(let matcher, let h): preToolUse.append((matcher: matcher, hook: h))
            case .postToolUse(let matcher, let h): postToolUse.append((matcher: matcher, hook: h))
            case .sessionEnd(let h): sessionEnd.append(h)
            case .server: continue
            }
        }
    }

    // MARK: Run methods (called by session/dispatch wiring)

    func runSessionStart() async -> String? {
        let ctx = SessionStartContext()
        var parts: [String] = []
        for hook in sessionStart {
            do {
                if let result = try await warnIfSlow("sessionStart", { try await hook(ctx) }),
                   let text = result.additionalContext,
                   !text.isEmpty {
                    parts.append(text)
                }
            } catch {
                log.error("sessionStart hook threw: \(error, privacy: .public)")
            }
        }
        return parts.isEmpty ? nil : parts.joined(separator: "\n\n")
    }

    func runPreToolUse(
        toolName: String,
        arguments: [String: JSONValue],
        sessionId: String
    ) async -> PreToolUseOutcome {
        var current = arguments
        for entry in preToolUse {
            guard toolNameMatches(toolName, entry.matcher) else { continue }
            let ctx = PreToolUseContext(toolName: toolName, arguments: current, sessionId: sessionId)
            do {
                guard let result = try await warnIfSlow("preToolUse", tool: toolName, { try await entry.hook(ctx) }) else { continue }
                if result.permission == .deny {
                    // Empty-string reason folds to the default, matching the
                    // reference's `reason or "denied by hook"`.
                    let reason = result.reason.flatMap { $0.isEmpty ? nil : $0 } ?? "denied by hook"
                    log.info("preToolUse hook denied tool \(toolName, privacy: .public): \(reason, privacy: .public)")
                    return PreToolUseOutcome(denied: true, reason: reason, arguments: current)
                }
                if let updated = result.updatedArguments {
                    current = updated
                }
            } catch {
                log.error("preToolUse hook threw for \(toolName, privacy: .public): \(error, privacy: .public)")
            }
        }
        return PreToolUseOutcome(denied: false, reason: nil, arguments: current)
    }

    func runPostToolUse(_ ctx: PostToolUseContext) async {
        for entry in postToolUse {
            guard toolNameMatches(ctx.toolName, entry.matcher) else { continue }
            do {
                try await warnIfSlow("postToolUse", tool: ctx.toolName) { try await entry.hook(ctx) }
            } catch {
                log.error("postToolUse hook threw for \(ctx.toolName, privacy: .public): \(error, privacy: .public)")
            }
        }
    }

    func runSessionEnd(_ ctx: SessionEndContext) async {
        for hook in sessionEnd {
            do {
                try await warnIfSlow("sessionEnd") { try await hook(ctx) }
            } catch {
                log.error("sessionEnd hook threw: \(error, privacy: .public)")
            }
        }
    }
}

// MARK: - Internal outcome type

struct PreToolUseOutcome: Sendable {
    let denied: Bool
    let reason: String?
    let arguments: [String: JSONValue]
}

// MARK: - Matcher

/// A hook matcher with an unterminated ``[...]`` group, rejected at
/// registration.
public struct MalformedHookMatcherError: Error, CustomStringConvertible, Sendable {
    public let pattern: String
    public let index: Int

    public var description: String {
        "malformed hook matcher \"\(pattern)\": unterminated '[' at index \(index)"
    }
}

/// Reject an unterminated ``[...]`` group at hook-registration time.
///
/// ``fnmatch(3)`` never errors on a malformed pattern — it treats a stray
/// ``[`` as a literal character, so e.g. ``matcher: "[delete_*"`` would
/// silently never match any real tool name instead of erroring. For a
/// ``PreToolUse`` deny matcher that is a silent fail-open (the guard never
/// fires), so this fails loud instead.
func validateMatcher(_ pattern: String) throws {
    let chars = Array(pattern)
    let n = chars.count
    var i = 0
    while i < n {
        if chars[i] == "[" {
            var j = i + 1
            if j < n, chars[j] == "!" { j += 1 }
            if j < n, chars[j] == "]" { j += 1 }
            while j < n, chars[j] != "]" { j += 1 }
            if j >= n {
                throw MalformedHookMatcherError(pattern: pattern, index: i)
            }
            i = j + 1
        } else {
            i += 1
        }
    }
}

// Normative grammar is pinned by the shared hook-matcher vectors
// (shared with the Python suite); internal so the conformance test can
// execute the vectors directly.
func toolNameMatches(_ name: String, _ pattern: String?) -> Bool {
    guard let pattern else { return true }
    return name.withCString { n in pattern.withCString { p in fnmatch(p, n, 0) == 0 } }
}
