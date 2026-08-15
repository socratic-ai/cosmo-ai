import Foundation
import LiveKit
import os

// Binds client-tool handlers (the public ``SessionConfig.Tool.client``
// surface carries no transport vocabulary) to the LiveKit RPC transport.
// The agents runtime drives client tools over
// ``localParticipant.registerRpcMethod`` / ``performRpc``: each handler
// becomes an RPC method whose request payload is the JSON-encoded args
// and whose reply is the JSON envelope ``{ok, result, error}``.
//
// Mirrors the reference SDK's ``_client_tools.py`` — keep the two in sync.

private let clientToolLog = Logger(subsystem: CosmoRealtimeLog.subsystem, category: "client-tools")

private let clientToolTruncationSuffix = ClientToolReply.truncationSuffix

private func shrinkOne(_ text: String, maxScalars: Int) -> String {
    let scalars = text.unicodeScalars
    guard scalars.count > maxScalars else { return text }
    let kept = String(String.UnicodeScalarView(scalars.prefix(maxScalars)))
    let shortened = kept + clientToolTruncationSuffix
    // Never spend more bytes than the string being replaced: the suffix is
    // longer than what it stands in for on a short string. Keeping the whole
    // string there is both smaller and truthful, and it is what makes the
    // shortened size rise monotonically with the allowance — the property
    // ``clientToolSuccessReply``'s binary search needs to be able to prune.
    return shortened.utf8.count >= text.utf8.count ? text : shortened
}

/// Shorten every string in ``value`` to at most ``maxScalars`` Unicode
/// scalars, leaving any string the suffix would not actually shrink. Applied
/// to the original each time, so a second pass never truncates a suffix the
/// first wrote. Scalars rather than ``String/count``'s grapheme clusters: the
/// one unit all three SDKs count identically. Pinned by `replyLimits.shrink`.
func shrinkStrings(_ value: JSONValue, maxScalars: Int) -> JSONValue {
    switch value {
    case .string(let text):
        return .string(shrinkOne(text, maxScalars: maxScalars))
    case .array(let items):
        return .array(items.map { shrinkStrings($0, maxScalars: maxScalars) })
    case .object(let fields):
        return .object(fields.mapValues { shrinkStrings($0, maxScalars: maxScalars) })
    case .int, .double, .bool, .null:
        return value
    }
}

private func longestStringLength(_ value: JSONValue) -> Int {
    switch value {
    case .string(let text): return text.unicodeScalars.count
    case .array(let items): return items.map(longestStringLength).max() ?? 0
    case .object(let fields): return fields.values.map(longestStringLength).max() ?? 0
    default: return 0
    }
}

private func serializedBytes(_ fields: [String: JSONValue]) -> Int {
    (try? JSONEncoder().encode(fields).count) ?? 0
}

/// What one top-level entry costs the envelope — its key as well as its value,
/// since a long key spends the same bytes a long value does.
private func entryBytes(_ fields: [String: JSONValue], _ key: String) -> Int {
    serializedBytes([key: fields[key] ?? .null])
}

/// ``result`` plus the truncation marker: the note, and how much of
/// ``originalBytes`` survived.
private func markedResult(
    _ result: [String: JSONValue], originalBytes: Int
) -> [String: JSONValue] {
    var marked = result
    marked[ClientToolReply.truncationMarkerKey] = .object([
        "note": .string(ClientToolReply.truncationMarkerNote),
        "kept_bytes": .int(serializedBytes(result)),
        "original_bytes": .int(originalBytes),
    ])
    return marked
}

/// An ``{ok: true}`` envelope whose serialized form fits the size cap.
///
/// An over-budget result is shortened structurally rather than by cutting the
/// serialized envelope, so the reply the model reads is always well-formed
/// JSON: strings shrink to the largest common allowance that fits, and if the
/// non-string structure alone still overflows, top-level entries are dropped
/// largest-first. Either way the result carries
/// ``ClientToolReply/truncationMarkerKey`` so the model knows to ask a
/// narrower question instead of reading the reply as the whole answer.
func clientToolSuccessReply(_ result: [String: JSONValue]) -> (reply: String, truncated: Bool) {
    let envelope = ClientToolReply.envelope(ok: true, result: result)
    if envelope.utf8.count <= ClientToolReply.maxBytes { return (envelope, false) }
    let originalBytes = serializedBytes(result)

    // Largest per-string allowance that fits. JSON-escaping makes encoded size
    // unpredictable from character counts, so search rather than compute it.
    var low = 0
    var high = longestStringLength(.object(result))
    var best: String?
    while low <= high {
        let mid = low + (high - low) / 2
        let shrunk = shrinkStrings(.object(result), maxScalars: mid)
        guard case .object(let fields) = shrunk else { break }
        let candidate = ClientToolReply.envelope(ok: true, result: markedResult(fields, originalBytes: originalBytes))
        if candidate.utf8.count <= ClientToolReply.maxBytes {
            best = candidate
            low = mid + 1
        } else {
            high = mid - 1
        }
    }
    if let best { return (best, true) }

    // Non-string structure (long arrays, many keys) is what overflows: drop
    // top-level entries, biggest first, until what remains fits. Each entry is
    // sized once, and how many to drop is found by binary search — dropping
    // more only ever shrinks the reply, so the fit is monotone in the count.
    guard case .object(let fields) = shrinkStrings(.object(result), maxScalars: 0) else {
        return (ClientToolReply.envelope(ok: true, result: markedResult([:], originalBytes: originalBytes)), true)
    }
    let widestFirst = fields.keys.sorted {
        (entryBytes(fields, $0), $0) > (entryBytes(fields, $1), $1)
    }
    func afterDropping(_ count: Int) -> String {
        var kept = fields
        for key in widestFirst.prefix(count) { kept.removeValue(forKey: key) }
        return ClientToolReply.envelope(ok: true, result: markedResult(kept, originalBytes: originalBytes))
    }
    low = 1
    high = widestFirst.count
    var fitted: String?
    while low <= high {
        let mid = low + (high - low) / 2
        let candidate = afterDropping(mid)
        if candidate.utf8.count <= ClientToolReply.maxBytes {
            fitted = candidate
            high = mid - 1
        } else {
            low = mid + 1
        }
    }
    return (
        fitted
            ?? ClientToolReply.envelope(
                ok: true, result: markedResult([:], originalBytes: originalBytes)),
        true
    )
}

/// Serialize ``build(text)``, shrinking ``text`` until the envelope fits the
/// size cap. Cuts on Unicode scalar boundaries — ``String/prefix(_:)`` would
/// cut on grapheme clusters, so the same message would shorten to different
/// text here than in the sibling SDKs.
private func fitByShrinking(_ text: String, _ build: (String) -> String) -> String {
    // JSON-escaping and the multi-byte suffix make the encoded size hard to
    // predict from the text length, so shrink the kept prefix until it fits.
    let scalars = Array(text.unicodeScalars)
    var keep = scalars.count
    while keep > 0 {
        let kept = String(String.UnicodeScalarView(scalars.prefix(keep)))
        let candidate = build(kept + clientToolTruncationSuffix)
        let size = candidate.utf8.count
        if size <= ClientToolReply.maxBytes { return candidate }
        keep -= max(size - ClientToolReply.maxBytes, 1)
    }
    return build(clientToolTruncationSuffix)
}

/// An ``{ok: false}`` envelope whose serialized form fits the size cap,
/// truncating the error text if needed.
func clientToolErrorReply(_ message: String) -> String {
    let envelope = ClientToolReply.envelope(ok: false, error: message)
    if envelope.utf8.count <= ClientToolReply.maxBytes { return envelope }
    return fitByShrinking(message) { ClientToolReply.envelope(ok: false, error: $0) }
}

/// Decode the RPC request, run the handler, and build the reply envelope.
/// A non-object args payload or a handler throw maps to an ``{ok: false}``
/// envelope; a successful handler maps to ``{ok: true, result: <object>}``,
/// shortened to fit ``ClientToolReply/maxBytes`` if it has to be. The
/// ``PostToolUse`` outcome carries the handler's own result, not the
/// shortened one — the cap is a transport property, not a tool failure.
/// When ``hooks`` is non-nil and a ``sessionId`` exists, fires
/// ``PreToolUse`` before the handler (and may skip it on deny) and
/// ``PostToolUse`` after (mirrors the reference ``_invoke_handler`` in
/// ``_client_tools.py``, including its skip-without-session-id gate).
func invokeClientToolHandler(
    _ handler: ClientToolHandler,
    tool toolName: String,
    payload: String,
    hooks: HookEngine?,
    sessionId: String?
) async -> String {
    var args: [String: JSONValue]
    if payload.isEmpty {
        args = [:]
    } else {
        guard let decoded = try? JSONDecoder().decode(JSONValue.self, from: Data(payload.utf8)) else {
            clientToolLog.warning("client tool args were not valid JSON tool=\(toolName, privacy: .public)")
            return clientToolErrorReply("client tool args were not valid JSON")
        }
        guard case .object(let object) = decoded else {
            clientToolLog.warning("client tool args must be a JSON object tool=\(toolName, privacy: .public)")
            return clientToolErrorReply("client tool args must be a JSON object")
        }
        args = object
    }

    var argsRewritten = false
    if let hooks, let sessionId {
        let outcome = await hooks.runPreToolUse(toolName: toolName, arguments: args, sessionId: sessionId)
        if outcome.denied {
            let reason = outcome.reason ?? "denied by hook"
            let reply = clientToolErrorReply(reason)
            await hooks.runPostToolUse(PostToolUseContext(
                toolName: toolName,
                arguments: outcome.arguments,
                outcome: .denied(reason),
                sessionId: sessionId
            ))
            return reply
        }
        argsRewritten = outcome.arguments != args
        args = outcome.arguments
    }

    let reply: String
    let toolOutcome: ToolOutcome
    do {
        let result = try await handler(args)
        let built = clientToolSuccessReply(result)
        if built.truncated {
            clientToolLog.warning("client tool result truncated to fit the reply size limit tool=\(toolName, privacy: .public)")
        }
        reply = built.reply
        toolOutcome = .ok(result)
    } catch {
        clientToolLog.error("client tool handler failed tool=\(toolName, privacy: .public): \(error.localizedDescription, privacy: .public)")
        warnIfHookRewriteBrokeValidation(error, toolName: toolName, argsRewritten: argsRewritten)
        let message = error.localizedDescription.isEmpty
            ? String(describing: type(of: error))
            : error.localizedDescription
        reply = clientToolErrorReply(message)
        toolOutcome = .error(message)
    }

    if let hooks, let sessionId {
        await hooks.runPostToolUse(PostToolUseContext(
            toolName: toolName,
            arguments: args,
            outcome: toolOutcome,
            sessionId: sessionId
        ))
    }
    return reply
}

/// Authorization predicate for a client-tool RPC: only the session's
/// agent participant (``kind == .agent``) whose identity matches the
/// caller may invoke a client tool — they type, click, and read the
/// user's screen, so a non-agent caller is rejected. Pure over a snapshot
/// of the room's remote participants so the security boundary is
/// unit-testable without a live room. Fails closed: an empty snapshot
/// (e.g. the room was torn down) authorizes no one.
func isAuthorizedClientToolCaller(
    callerIdentity: String,
    participants: [(identity: String, isAgent: Bool)]
) -> Bool {
    participants.contains { $0.identity == callerIdentity && $0.isAgent }
}

/// A client tool declared in ``SessionConfig`` could not be bound to the
/// transport. The tool was already advertised to the server, so the start
/// fails closed rather than running with a tool the agent can call but
/// this client cannot service.
struct ClientToolRegistrationError: Error, LocalizedError {
    let tool: String
    let underlying: Error
    var errorDescription: String? {
        "client tool '\(tool)' could not be registered: \(underlying.localizedDescription)"
    }
}

/// Register one RPC method per client tool that carries a handler. Only
/// the session's agent participant may invoke a client tool; an
/// invocation from any non-agent caller is rejected before the handler
/// runs so LiveKit surfaces an error to the caller.
///
/// ``sessionId`` is resolved per invocation, not captured at registration:
/// methods bind before the room joins (closing the join→register race), when
/// the server-minted id may not have arrived yet.
///
/// Throws ``ClientToolRegistrationError`` if any tool fails to bind: the
/// spec is already on the wire in ``session-config``, so failing the start
/// is preferable to advertising a tool whose every invocation would error.
func registerClientToolHandlers(
    on room: Room,
    handlers: [String: ClientToolHandler],
    hooks: HookEngine?,
    sessionId: @escaping @Sendable () async -> String?
) async throws {
    for (name, handler) in handlers {
        do {
            try await room.registerRpcMethod(name) { [weak room] data in
                // Client tools type, click, and read the user's screen —
                // only the session agent may drive them.
                let participants = (room?.remoteParticipants.values).map { values in
                    values.compactMap { p -> (identity: String, isAgent: Bool)? in
                        guard let id = p.identity?.stringValue else { return nil }
                        return (identity: id, isAgent: p.kind == .agent)
                    }
                } ?? []
                let callerIsAgent = isAuthorizedClientToolCaller(
                    callerIdentity: data.callerIdentity.stringValue,
                    participants: participants
                )
                guard callerIsAgent else {
                    clientToolLog.error(
                        "client-tool RPC rejected: caller \(data.callerIdentity.stringValue, privacy: .public) is not the session agent tool=\(name, privacy: .public)"
                    )
                    throw NonAgentRpcCallerError()
                }
                return await invokeClientToolHandler(
                    handler,
                    tool: name,
                    payload: data.payload,
                    hooks: hooks,
                    sessionId: await sessionId()
                )
            }
        } catch {
            clientToolLog.error(
                "client-tool RPC register failed tool=\(name, privacy: .public) error=\(error.localizedDescription, privacy: .public)"
            )
            throw ClientToolRegistrationError(tool: name, underlying: error)
        }
        clientToolLog.info("client tool registered tool=\(name, privacy: .public)")
    }
}

/// Thrown from the client-tool RPC handler when the caller is not the session
/// agent — the agent-only caller guard.
struct NonAgentRpcCallerError: Error {}

// MARK: - Background client tools (deferred path)

/// The deferred-ack reply envelope: ``{ok:true, deferred:true, job_id, result:{note}}``,
/// shrinking the note if needed so the envelope fits the size cap.
/// The worker registers the job from ``job_id`` and injects the terminal result
/// (delivered later via ``tool_job_result``) into the live session.
func clientToolDeferredReply(jobId: String, note: String) -> String {
    func build(_ note: String) -> String {
        let object: [String: JSONValue] = [
            "ok": .bool(true),
            "result": .object(note.isEmpty ? [:] : ["note": .string(note)]),
            "error": .null,
            "deferred": .bool(true),
            "job_id": .string(jobId),
        ]
        guard let data = try? JSONEncoder().encode(object) else {
            return #"{"ok":false,"result":null,"error":"reply encode failed"}"#
        }
        return String(decoding: data, as: UTF8.self)
    }
    let envelope = build(note)
    if envelope.utf8.count <= ClientToolReply.maxBytes { return envelope }
    clientToolLog.warning("client tool ack note truncated to fit the reply size limit job_id=\(jobId, privacy: .public)")
    return fitByShrinking(note, build)
}

private func decodeClientToolArgs(_ payload: String, tool toolName: String) -> [String: JSONValue]? {
    if payload.isEmpty { return [:] }
    guard let decoded = try? JSONDecoder().decode(JSONValue.self, from: Data(payload.utf8)) else {
        clientToolLog.warning("client tool args were not valid JSON tool=\(toolName, privacy: .public)")
        return nil
    }
    guard case .object(let object) = decoded else {
        clientToolLog.warning("client tool args must be a JSON object tool=\(toolName, privacy: .public)")
        return nil
    }
    return object
}

/// Drive a background handler: decode, PreToolUse, then run it on a sink-owned
/// task and race two outcomes — the handler calling ``job.ack`` (a deferred
/// reply, the task kept alive) versus the handler finishing/raising before it
/// acks (an error reply now). PostToolUse fires at the terminal signal for a
/// deferred call (in ``ClientToolJob``), or here for a pre-ack failure.
/// Mirrors the reference ``_invoke_deferred_handler`` in ``_client_tools.py``.
func invokeBackgroundClientToolHandler(
    _ handler: @escaping BackgroundClientToolHandler,
    tool toolName: String,
    payload: String,
    sink: ClientToolJobSink,
    hooks: HookEngine?,
    sessionId: String?
) async -> String {
    guard let decoded = decodeClientToolArgs(payload, tool: toolName) else {
        return clientToolErrorReply("client tool args must be a JSON object")
    }
    var args = decoded

    var argsRewritten = false
    if let hooks, let sessionId {
        let outcome = await hooks.runPreToolUse(toolName: toolName, arguments: args, sessionId: sessionId)
        if outcome.denied {
            let reason = outcome.reason ?? "denied by hook"
            await hooks.runPostToolUse(PostToolUseContext(
                toolName: toolName, arguments: outcome.arguments,
                outcome: .denied(reason), sessionId: sessionId
            ))
            return clientToolErrorReply(reason)
        }
        argsRewritten = outcome.arguments != args
        args = outcome.arguments
    }
    let resolvedArgs = args
    let resolvedArgsRewritten = argsRewritten

    let job = ClientToolJob(
        jobId: UUID().uuidString,
        toolName: toolName,
        sink: sink,
        hooks: hooks,
        sessionId: sessionId,
        arguments: resolvedArgs
    )
    await sink.spawn {
        await runBackgroundHandler(
            handler, resolvedArgs, job, tool: toolName, argsRewritten: resolvedArgsRewritten
        )
    }

    switch await job.awaitOutcome() {
    case .acked(let note):
        // Deferred: the task keeps running (the sink owns it); the terminal
        // result + PostToolUse arrive later via job.complete / job.fail.
        clientToolLog.info("client tool deferred tool=\(toolName, privacy: .public) job_id=\(job.jobId, privacy: .public)")
        return clientToolDeferredReply(jobId: job.jobId, note: note)
    case .finishedWithoutAck:
        let message = "background client tool returned without acking or completing"
        clientToolLog.warning("realtime.client_tool_job.finished_without_ack tool=\(toolName, privacy: .public)")
        await firePostToolUse(hooks, sessionId, toolName, resolvedArgs, .error(message))
        return clientToolErrorReply(message)
    case .failedBeforeAck(let message):
        await firePostToolUse(hooks, sessionId, toolName, resolvedArgs, .error(message))
        return clientToolErrorReply(message)
    }
}

/// Run a background handler. A raise after ``ack`` becomes ``job.fail`` (the
/// deferred reply already went out); a raise before ``ack`` — or a clean return
/// without acking — settles the dispatcher's reply race so it can build the
/// inline reply.
private func runBackgroundHandler(
    _ handler: @escaping BackgroundClientToolHandler,
    _ args: [String: JSONValue],
    _ job: ClientToolJob,
    tool toolName: String,
    argsRewritten: Bool
) async {
    do {
        try await handler(args, job)
        await job.settleUnacked(.finishedWithoutAck)
        if await job.acked, await !job.settled {
            // An acked job the handler abandoned (returned without
            // complete/fail): settle it as a failure so the server-side call
            // is not left waiting forever.
            clientToolLog.warning("realtime.client_tool_job.abandoned tool=\(toolName, privacy: .public) job_id=\(job.jobId, privacy: .public)")
            do {
                try await job.fail(error: "background client tool returned without completing")
            } catch {
                clientToolLog.error("realtime.client_tool_job.failure_undeliverable tool=\(toolName, privacy: .public)")
            }
        }
    } catch {
        let message = error.localizedDescription.isEmpty
            ? String(describing: type(of: error))
            : error.localizedDescription
        if await job.acked {
            clientToolLog.error("client tool background handler failed after ack tool=\(toolName, privacy: .public): \(message, privacy: .public)")
            do {
                try await job.fail(error: message)
            } catch {
                // Sink-owned tasks are settle-only: an undeliverable failure
                // result is logged, never rethrown into the tracked task.
                clientToolLog.error("client tool job failure result undeliverable tool=\(toolName, privacy: .public): \(error.localizedDescription, privacy: .public)")
            }
        } else {
            clientToolLog.error("client tool background handler failed before ack tool=\(toolName, privacy: .public): \(message, privacy: .public)")
            warnIfHookRewriteBrokeValidation(error, toolName: toolName, argsRewritten: argsRewritten)
            await job.settleUnacked(.failedBeforeAck(message: message))
        }
    }
}

/// A PreToolUse hook can rewrite valid model args into invalid handler args;
/// the resulting INVALID_INPUT envelope would wrongly tell the model to
/// retry. Only this layer knows a rewrite happened, so surface it as a
/// structured event (the envelope is unchanged).
private func warnIfHookRewriteBrokeValidation(
    _ error: Error,
    toolName: String,
    argsRewritten: Bool
) {
    if argsRewritten, error is ToolInputValidationError {
        clientToolLog.warning("realtime.client_tool_validation_failed_after_hook_rewrite tool=\(toolName, privacy: .public)")
    }
}

private func firePostToolUse(
    _ hooks: HookEngine?,
    _ sessionId: String?,
    _ toolName: String,
    _ args: [String: JSONValue],
    _ outcome: ToolOutcome
) async {
    guard let hooks, let sessionId else { return }
    await hooks.runPostToolUse(PostToolUseContext(
        toolName: toolName, arguments: args, outcome: outcome, sessionId: sessionId
    ))
}

/// Register one RPC method per background client tool, guarded to the session
/// agent, dispatching through the deferred path with ``sink``. ``sessionId``
/// resolves per invocation, like ``registerClientToolHandlers``.
func registerBackgroundClientToolHandlers(
    on room: Room,
    handlers: [String: BackgroundClientToolHandler],
    sink: ClientToolJobSink,
    hooks: HookEngine?,
    sessionId: @escaping @Sendable () async -> String?
) async throws {
    for (name, handler) in handlers {
        do {
            try await room.registerRpcMethod(name) { [weak room] data in
                let participants = (room?.remoteParticipants.values).map { values in
                    values.compactMap { p -> (identity: String, isAgent: Bool)? in
                        guard let id = p.identity?.stringValue else { return nil }
                        return (identity: id, isAgent: p.kind == .agent)
                    }
                } ?? []
                guard isAuthorizedClientToolCaller(
                    callerIdentity: data.callerIdentity.stringValue,
                    participants: participants
                ) else {
                    clientToolLog.error(
                        "client-tool RPC rejected: caller \(data.callerIdentity.stringValue, privacy: .public) is not the session agent tool=\(name, privacy: .public)"
                    )
                    throw NonAgentRpcCallerError()
                }
                return await invokeBackgroundClientToolHandler(
                    handler, tool: name, payload: data.payload,
                    sink: sink, hooks: hooks, sessionId: await sessionId()
                )
            }
        } catch {
            clientToolLog.error(
                "background client-tool RPC register failed tool=\(name, privacy: .public) error=\(error.localizedDescription, privacy: .public)"
            )
            throw ClientToolRegistrationError(tool: name, underlying: error)
        }
        clientToolLog.info("background client tool registered tool=\(name, privacy: .public)")
    }
}
