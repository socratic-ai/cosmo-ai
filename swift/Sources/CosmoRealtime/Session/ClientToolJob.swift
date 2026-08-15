import Foundation
import os

// The background client-tool job model — the Swift port of the reference SDK's
// ``_client_tool_jobs.py``. A ``BackgroundClientTool`` handler receives a
// ``ClientToolJob`` to ack the call and deliver its terminal result later; the
// session-scoped ``ClientToolJobSink`` owns the background tasks and the
// reverse-channel publish path.

private let jobLog = Logger(subsystem: CosmoRealtimeLog.subsystem, category: "client-tool-jobs")

// A deferred tool's terminal result rides the reliable data channel, which caps
// ~15 KiB per packet and is not chunked here. The model only ever sees
// ``summary``/``error``, so an oversized ``result`` is replaced with a small
// marker rather than silently failing the whole publish. Text is truncated.
private let maxTerminalTextChars = 2048
private let maxTerminalResultBytes = 8 * 1024
// The server's per-packet wire budget: a final fit pass bounds the serialized
// message — per-field caps alone can't, since JSON escaping inflates capped
// text past the packet budget.
private let maxJobMessageBytes = 12 * 1024
private let terminalTruncationSuffix = ClientToolReply.truncationSuffix

func shrinkTerminalText(_ text: String?, keep: Int) -> String? {
    guard let text, text.count > keep else { return text }
    return String(text.prefix(keep)) + terminalTruncationSuffix
}

func capTerminalText(_ text: String?) -> String? {
    guard let text, text.count > maxTerminalTextChars else { return text }
    return String(text.prefix(maxTerminalTextChars)) + terminalTruncationSuffix
}

func capTerminalResult(_ result: [String: JSONValue]?) -> [String: JSONValue]? {
    guard let result else { return nil }
    let bytes = (try? JSONEncoder().encode(result).count) ?? 0
    if bytes <= maxTerminalResultBytes { return result }
    jobLog.warning("realtime.client_tool_job.result_truncated bytes=\(bytes, privacy: .public)")
    return ["_truncated": .bool(true), "_original_bytes": .int(bytes)]
}

/// The terminal outcome a background handler delivers — carried to the sink as
/// plain fields so this layer stays free of the generated wire type.
public struct BackgroundToolResult: Sendable {
    public enum Status: String, Sendable { case completed, failed }
    public let jobId: String
    public let toolName: String
    public let status: Status
    public let result: [String: JSONValue]?
    public let summary: String?
    public let error: String?
}

/// Session-scoped owner of long-running client-tool background work: the
/// reverse-channel publish path (a ``tool_job_result`` message) and the set of
/// in-flight handler tasks — strong refs cancelled on session teardown. One per
/// session; the runtime constructs it and passes it into registration.
public actor ClientToolJobSink {
    private let deliver: @Sendable (BackgroundToolResult) async throws -> Void
    private let isOpen: @Sendable () async -> Bool
    private var tasks: [UUID: Task<Void, Never>] = [:]

    public init(
        deliver: @escaping @Sendable (BackgroundToolResult) async throws -> Void,
        isOpen: @escaping @Sendable () async -> Bool
    ) {
        self.deliver = deliver
        self.isOpen = isOpen
    }

    func open() async -> Bool { await isOpen() }

    func publish(_ result: BackgroundToolResult) async throws { try await deliver(result) }

    /// Run ``body`` as a tracked background task (strong ref until it finishes;
    /// cancelled on ``close()``).
    func spawn(_ body: @escaping @Sendable () async -> Void) {
        let id = UUID()
        let task = Task { [weak self] in
            await body()
            await self?.taskFinished(id)
        }
        tasks[id] = task
    }

    private func taskFinished(_ id: UUID) { tasks[id] = nil }

    /// Cancel every in-flight handler task — their results have nowhere to land
    /// once the session is torn down.
    func close() {
        for task in tasks.values { task.cancel() }
        tasks.removeAll()
    }

    /// Await every currently-tracked handler task. Used by tests to observe a
    /// job's terminal delivery after the dispatcher returns the deferred reply.
    func drain() async {
        for task in Array(tasks.values) { await task.value }
    }
}

/// Handle a background client tool uses to ack the call, then deliver its
/// terminal result later. Passed as the second argument to a
/// ``BackgroundClientToolHandler``. Call ``ack(_:)`` to release the RPC reply
/// while the handler keeps running, then ``complete(result:summary:)`` or
/// ``fail(error:)`` when the work finishes. All are idempotent once delivered;
/// a terminal call after the session has closed is dropped, and a failed
/// publish throws and leaves the job retryable.
public actor ClientToolJob {
    /// What the dispatcher's reply race resolves to.
    enum Outcome: Sendable {
        case acked(note: String)
        case finishedWithoutAck
        case failedBeforeAck(message: String)
    }

    public let jobId: String
    public let toolName: String
    private let sink: ClientToolJobSink
    private let hooks: HookEngine?
    private let sessionId: String?
    private let arguments: [String: JSONValue]

    private var ackedFlag = false
    private var terminal = false

    /// True once a terminal result was delivered (unlatched again by a failed
    /// publish, which leaves the job retryable).
    var settled: Bool { terminal }
    private var outcomeSettled = false
    private var pendingOutcome: Outcome?
    private var outcomeContinuation: CheckedContinuation<Outcome, Never>?

    init(
        jobId: String,
        toolName: String,
        sink: ClientToolJobSink,
        hooks: HookEngine?,
        sessionId: String?,
        arguments: [String: JSONValue]
    ) {
        self.jobId = jobId
        self.toolName = toolName
        self.sink = sink
        self.hooks = hooks
        self.sessionId = sessionId
        self.arguments = arguments
    }

    public var acked: Bool { ackedFlag }

    /// Release the RPC reply as a deferred ack. ``note`` is the model-facing
    /// text spoken at acceptance. Later ``ack`` calls are ignored.
    public func ack(_ note: String = "") {
        guard !ackedFlag else {
            jobLog.warning("realtime.client_tool_job.ack_ignored tool=\(self.toolName, privacy: .public) job_id=\(self.jobId, privacy: .public)")
            return
        }
        ackedFlag = true
        settle(.acked(note: note))
    }

    /// Deliver a successful terminal result. Idempotent once delivered; a
    /// failed publish throws and leaves the job retryable.
    public func complete(result: [String: JSONValue]? = nil, summary: String? = nil) async throws {
        try await deliverTerminal(
            status: .completed, result: result, summary: summary, error: nil,
            outcome: .ok(result ?? [:])
        )
    }

    /// Deliver a failed terminal result. Idempotent once delivered; a failed
    /// publish throws and leaves the job retryable.
    public func fail(error: String) async throws {
        try await deliverTerminal(
            status: .failed, result: nil, summary: nil, error: error,
            outcome: .error(error)
        )
    }

    // The dispatcher awaits this; whichever of ack / finish-without-ack /
    // fail-before-ack happens first resolves it.
    func awaitOutcome() async -> Outcome {
        if let pending = pendingOutcome { return pending }
        return await withCheckedContinuation { continuation in
            outcomeContinuation = continuation
        }
    }

    // Called by the handler wrapper when the handler finishes/throws before
    // acking; no-op once the outcome is settled (i.e. once acked).
    func settleUnacked(_ outcome: Outcome) { settle(outcome) }

    private func settle(_ outcome: Outcome) {
        guard !outcomeSettled else { return }
        outcomeSettled = true
        if let continuation = outcomeContinuation {
            outcomeContinuation = nil
            continuation.resume(returning: outcome)
        } else {
            pendingOutcome = outcome
        }
    }

    private func deliverTerminal(
        status: BackgroundToolResult.Status,
        result: [String: JSONValue]?,
        summary: String?,
        error: String?,
        outcome: ToolOutcome
    ) async throws {
        // A handler that completes/fails without ever acking still needs the
        // RPC reply to go out deferred, or the worker never registers the job.
        if !ackedFlag {
            jobLog.warning("realtime.client_tool_job.terminal_before_ack tool=\(self.toolName, privacy: .public) job_id=\(self.jobId, privacy: .public)")
            ack("")
        }
        guard !terminal else {
            jobLog.warning("realtime.client_tool_job.terminal_ignored tool=\(self.toolName, privacy: .public) job_id=\(self.jobId, privacy: .public)")
            return
        }
        terminal = true
        var cappedResult = capTerminalResult(result)
        var cappedSummary = capTerminalText(summary)
        var cappedError = capTerminalText(error)
        func encodedBytes() -> Int {
            var dict: [String: JSONValue] = [
                "type": .string("tool_job_result"),
                "job_id": .string(jobId),
                "tool_name": .string(toolName),
                "status": .string(status.rawValue),
            ]
            if let cappedResult { dict["result"] = .object(cappedResult) }
            if let cappedSummary { dict["summary"] = .string(cappedSummary) }
            if let cappedError { dict["error"] = .string(cappedError) }
            return (try? JSONEncoder().encode(dict).count) ?? 0
        }
        if encodedBytes() > maxJobMessageBytes {
            jobLog.warning("realtime.client_tool_job.message_shrunk_to_fit tool=\(self.toolName, privacy: .public) job_id=\(self.jobId, privacy: .public)")
            if cappedResult != nil { cappedResult = ["_truncated": .bool(true)] }
            var keep = maxTerminalTextChars
            while encodedBytes() > maxJobMessageBytes, keep > 0 {
                keep /= 2
                cappedSummary = shrinkTerminalText(cappedSummary, keep: keep)
                cappedError = shrinkTerminalText(cappedError, keep: keep)
            }
        }
        guard await sink.open() else {
            jobLog.warning("realtime.client_tool_job.after_close tool=\(self.toolName, privacy: .public) job_id=\(self.jobId, privacy: .public)")
            return
        }
        do {
            try await sink.publish(
                BackgroundToolResult(
                    jobId: jobId,
                    toolName: toolName,
                    status: status,
                    result: cappedResult,
                    summary: cappedSummary,
                    error: cappedError
                )
            )
        } catch {
            // A failed publish must not latch the job as delivered: unlatch so
            // the caller can retry, and rethrow so the dropped result is
            // observable instead of silently lost.
            terminal = false
            jobLog.error("realtime.client_tool_job.publish_failed tool=\(self.toolName, privacy: .public) job_id=\(self.jobId, privacy: .public) error=\(error.localizedDescription, privacy: .public)")
            throw error
        }
        // The hook observes the uncapped outcome; only the wire message is
        // truncated. Mirrors the reference `_deliver`.
        if let hooks, let sessionId {
            await hooks.runPostToolUse(PostToolUseContext(
                toolName: toolName,
                arguments: arguments,
                outcome: outcome,
                sessionId: sessionId
            ))
        }
    }
}

public typealias BackgroundClientToolHandler =
    @Sendable ([String: JSONValue], ClientToolJob) async throws -> Void
