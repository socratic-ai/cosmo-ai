import Foundation
import Testing
@testable import CosmoRealtime

@Suite("Background client-tool jobs")
struct ClientToolJobTests {

    private struct BgError: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    /// Collects the terminal results a job publishes over its sink.
    private actor Capture {
        private(set) var results: [BackgroundToolResult] = []
        func add(_ result: BackgroundToolResult) { results.append(result) }
    }

    private func makeSink(_ capture: Capture, open: Bool = true) -> ClientToolJobSink {
        ClientToolJobSink(
            deliver: { await capture.add($0) },
            isOpen: { open }
        )
    }

    private func decode(_ envelope: String) -> [String: JSONValue] {
        guard case .object(let fields)? = try? JSONDecoder().decode(
            JSONValue.self, from: Data(envelope.utf8)
        ) else {
            Issue.record("reply envelope was not a JSON object: \(envelope)")
            return [:]
        }
        return fields
    }

    @Test("ack yields a deferred reply; complete delivers over the sink")
    func ackDeferredAndCompletes() async {
        let capture = Capture()
        let sink = makeSink(capture)
        let handler: BackgroundClientToolHandler = { _, job in
            await job.ack("starting export")
            try await job.complete(result: ["url": .string("https://x")], summary: "ready")
        }

        let reply = decode(await invokeBackgroundClientToolHandler(
            handler, tool: "export", payload: "{}", sink: sink, hooks: nil, sessionId: nil
        ))
        #expect(reply["ok"] == .bool(true))
        #expect(reply["deferred"] == .bool(true))
        #expect(reply["result"] == .object(["note": .string("starting export")]))
        guard case .string(let jobId)? = reply["job_id"] else {
            Issue.record("deferred reply missing job_id")
            return
        }

        await sink.drain()
        let results = await capture.results
        #expect(results.count == 1)
        let terminal = results.first
        #expect(terminal?.jobId == jobId)
        #expect(terminal?.toolName == "export")
        #expect(terminal?.status == .completed)
        #expect(terminal?.summary == "ready")
        #expect(terminal?.result == ["url": .string("https://x")])
    }

    @Test("a handler that finishes without acking errors (not an inline result)")
    func finishedWithoutAckErrors() async {
        let capture = Capture()
        let sink = makeSink(capture)
        let handler: BackgroundClientToolHandler = { _, _ in }  // never acks

        let reply = decode(await invokeBackgroundClientToolHandler(
            handler, tool: "export", payload: "{}", sink: sink, hooks: nil, sessionId: nil
        ))
        #expect(reply["ok"] == .bool(false))
        if case .string(let message)? = reply["error"] {
            #expect(message.contains("without acking"))
        } else {
            Issue.record("expected an error string")
        }
        let results = await capture.results
        #expect(results.isEmpty)
    }

    @Test("a raise after ack auto-fails the job")
    func raiseAfterAckAutoFails() async {
        let capture = Capture()
        let sink = makeSink(capture)
        let handler: BackgroundClientToolHandler = { _, job in
            await job.ack("working")
            throw BgError(message: "kaboom")
        }

        let reply = decode(await invokeBackgroundClientToolHandler(
            handler, tool: "export", payload: "{}", sink: sink, hooks: nil, sessionId: nil
        ))
        #expect(reply["deferred"] == .bool(true))

        await sink.drain()
        let results = await capture.results
        #expect(results.count == 1)
        #expect(results.first?.status == .failed)
        #expect(results.first?.error?.contains("kaboom") == true)
    }

    @Test("an acked job the handler abandons is settled as a failure")
    func abandonedAfterAckAutoFails() async {
        // Returning after ack without complete/fail previously published
        // nothing, leaving the server-side call waiting forever (cross-SDK fix).
        let capture = Capture()
        let sink = makeSink(capture)
        let handler: BackgroundClientToolHandler = { _, job in
            await job.ack("started")
            // returns with no terminal call
        }

        let reply = decode(await invokeBackgroundClientToolHandler(
            handler, tool: "export", payload: "{}", sink: sink, hooks: nil, sessionId: nil
        ))
        #expect(reply["deferred"] == .bool(true))

        await sink.drain()
        let results = await capture.results
        #expect(results.count == 1)
        #expect(results.first?.status == .failed)
        #expect(results.first?.error?.contains("without completing") == true)
    }

    @Test("an over-budget terminal message is shrunk to the packet budget")
    func terminalMessageShrunkToFit() async {
        // Per-field caps alone can't bound the serialized message: capped text
        // made of JSON-escaping-heavy characters plus a near-cap result
        // overflows the packet budget; the fit pass degrades result to the
        // marker.
        let capture = Capture()
        let sink = makeSink(capture)
        let heavy = String(repeating: "\"", count: 4000)
        let blob = String(repeating: "x", count: 8100)
        let handler: BackgroundClientToolHandler = { _, job in
            await job.ack()
            try await job.complete(result: ["blob": .string(blob)], summary: heavy)
        }

        _ = await invokeBackgroundClientToolHandler(
            handler, tool: "export", payload: "{}", sink: sink, hooks: nil, sessionId: nil
        )
        await sink.drain()
        let results = await capture.results
        #expect(results.count == 1)
        #expect(results.first?.result == ["_truncated": .bool(true)])
        #expect(results.first?.summary?.hasSuffix("[truncated]") == true)
    }

    @Test("a raise before ack is an inline error reply")
    func raiseBeforeAckInlineError() async {
        let capture = Capture()
        let sink = makeSink(capture)
        let handler: BackgroundClientToolHandler = { _, _ in
            throw BgError(message: "bad args")
        }

        let reply = decode(await invokeBackgroundClientToolHandler(
            handler, tool: "export", payload: "{}", sink: sink, hooks: nil, sessionId: nil
        ))
        #expect(reply["ok"] == .bool(false))
        #expect(reply["deferred"] == nil)
        if case .string(let message)? = reply["error"] {
            #expect(message.contains("bad args"))
        } else {
            Issue.record("expected an error string")
        }
        let results = await capture.results
        #expect(results.isEmpty)
    }

    @Test("double complete is idempotent")
    func doubleCompleteIdempotent() async {
        let capture = Capture()
        let sink = makeSink(capture)
        let handler: BackgroundClientToolHandler = { _, job in
            await job.ack()
            try await job.complete(result: ["n": .int(1)])
            try await job.complete(result: ["n": .int(2)])  // ignored
        }

        _ = await invokeBackgroundClientToolHandler(
            handler, tool: "export", payload: "{}", sink: sink, hooks: nil, sessionId: nil
        )
        await sink.drain()
        let results = await capture.results
        #expect(results.count == 1)
        #expect(results.first?.result == ["n": .int(1)])
    }

    @Test("complete after the session closed is dropped")
    func completeAfterCloseDropped() async {
        let capture = Capture()
        let sink = makeSink(capture, open: false)  // session already gone
        let handler: BackgroundClientToolHandler = { _, job in
            await job.ack()
            try await job.complete(result: ["url": .string("x")])
        }

        _ = await invokeBackgroundClientToolHandler(
            handler, tool: "export", payload: "{}", sink: sink, hooks: nil, sessionId: nil
        )
        await sink.drain()
        let results = await capture.results
        #expect(results.isEmpty)
    }

    @Test("an oversized result is truncated but the summary is preserved")
    func oversizedResultTruncated() async {
        let capture = Capture()
        let sink = makeSink(capture)
        let big = String(repeating: "x", count: 20_000)
        let handler: BackgroundClientToolHandler = { _, job in
            await job.ack()
            try await job.complete(result: ["blob": .string(big)], summary: "ready")
        }

        _ = await invokeBackgroundClientToolHandler(
            handler, tool: "export", payload: "{}", sink: sink, hooks: nil, sessionId: nil
        )
        await sink.drain()
        let terminal = await capture.results.first
        #expect(terminal?.summary == "ready")
        #expect(terminal?.result?["_truncated"] == .bool(true))
    }

    // MARK: – PostToolUse at the terminal signal

    @Test("ack then complete fires PostToolUse with .ok, the args, and the session id")
    func deferredCompleteFiresPostToolUse() async throws {
        let capture = Capture()
        let sink = makeSink(capture)
        let postBox = CaptureBox<PostToolUseContext>()
        var registry: [Hook] = []
        registry.append(try postToolUse { ctx in await postBox.set(ctx) })
        let handler: BackgroundClientToolHandler = { _, job in
            await job.ack("starting")
            try await job.complete(result: ["url": .string("https://x")])
        }

        _ = await invokeBackgroundClientToolHandler(
            handler, tool: "export", payload: #"{"q":"now"}"#, sink: sink,
            hooks: HookEngine(registry), sessionId: "s1"
        )
        await sink.drain()

        let ctx = await postBox.value
        #expect(ctx?.toolName == "export")
        #expect(ctx?.sessionId == "s1")
        #expect(ctx?.arguments == ["q": .string("now")])
        #expect(ctx?.outcome == .ok(["url": .string("https://x")]))
    }

    @Test("ack then fail fires PostToolUse with .error")
    func deferredFailFiresPostToolUse() async throws {
        let capture = Capture()
        let sink = makeSink(capture)
        let postBox = CaptureBox<ToolOutcome>()
        var registry: [Hook] = []
        registry.append(try postToolUse { ctx in await postBox.set(ctx.outcome) })
        let handler: BackgroundClientToolHandler = { _, job in
            await job.ack()
            try await job.fail(error: "export broke")
        }

        _ = await invokeBackgroundClientToolHandler(
            handler, tool: "export", payload: "{}", sink: sink,
            hooks: HookEngine(registry), sessionId: "s1"
        )
        await sink.drain()

        #expect(await postBox.value == .error("export broke"))
    }

    @Test("a raise after ack fires PostToolUse with .error via the auto-fail")
    func raiseAfterAckFiresPostToolUseError() async throws {
        let capture = Capture()
        let sink = makeSink(capture)
        let postBox = CaptureBox<ToolOutcome>()
        var registry: [Hook] = []
        registry.append(try postToolUse { ctx in await postBox.set(ctx.outcome) })
        let handler: BackgroundClientToolHandler = { _, job in
            await job.ack("working")
            throw BgError(message: "kaboom")
        }

        _ = await invokeBackgroundClientToolHandler(
            handler, tool: "export", payload: "{}", sink: sink,
            hooks: HookEngine(registry), sessionId: "s1"
        )
        await sink.drain()

        if case .error(let message)? = await postBox.value {
            #expect(message.contains("kaboom"))
        } else {
            Issue.record("expected .error outcome from the post-ack raise")
        }
    }

    @Test("a handler that finishes without acking fires PostToolUse with .error")
    func finishedWithoutAckFiresPostToolUseError() async throws {
        let capture = Capture()
        let sink = makeSink(capture)
        let postBox = CaptureBox<ToolOutcome>()
        var registry: [Hook] = []
        registry.append(try postToolUse { ctx in await postBox.set(ctx.outcome) })
        let handler: BackgroundClientToolHandler = { _, _ in }  // never acks

        _ = await invokeBackgroundClientToolHandler(
            handler, tool: "export", payload: "{}", sink: sink,
            hooks: HookEngine(registry), sessionId: "s1"
        )

        if case .error(let message)? = await postBox.value {
            #expect(message.contains("without acking"))
        } else {
            Issue.record("expected .error outcome for finish-without-ack")
        }
    }

    @Test("a terminal delivered after the session closed does not fire PostToolUse")
    func afterCloseSkipsPostToolUse() async throws {
        let capture = Capture()
        let sink = makeSink(capture, open: false)
        let postBox = CaptureBox<ToolOutcome>()
        var registry: [Hook] = []
        registry.append(try postToolUse { ctx in await postBox.set(ctx.outcome) })
        let handler: BackgroundClientToolHandler = { _, job in
            await job.ack()
            try await job.complete(result: ["url": .string("x")])
        }

        _ = await invokeBackgroundClientToolHandler(
            handler, tool: "export", payload: "{}", sink: sink,
            hooks: HookEngine(registry), sessionId: "s1"
        )
        await sink.drain()

        #expect(await postBox.value == nil)
    }

    @Test("a duplicate terminal fires PostToolUse exactly once")
    func duplicateTerminalFiresPostToolUseOnce() async throws {
        let capture = Capture()
        let sink = makeSink(capture)
        let counter = Counter()
        var registry: [Hook] = []
        registry.append(try postToolUse { _ in await counter.increment() })
        let handler: BackgroundClientToolHandler = { _, job in
            await job.ack()
            try await job.complete(result: ["n": .int(1)])
            try await job.complete(result: ["n": .int(2)])  // ignored
        }

        _ = await invokeBackgroundClientToolHandler(
            handler, tool: "export", payload: "{}", sink: sink,
            hooks: HookEngine(registry), sessionId: "s1"
        )
        await sink.drain()

        #expect(await counter.value == 1)
    }

    @Test("a failed publish leaves the job retryable and defers PostToolUse")
    func failedPublishRetryableAndDefersPostToolUse() async throws {
        actor FlakySink {
            var failNext = true
            var published: [BackgroundToolResult] = []
            func deliver(_ result: BackgroundToolResult) throws {
                if failNext {
                    failNext = false
                    throw BgError(message: "data channel closed")
                }
                published.append(result)
            }
        }
        let flaky = FlakySink()
        let sink = ClientToolJobSink(
            deliver: { try await flaky.deliver($0) },
            isOpen: { true }
        )
        let firstError = CaptureBox<String>()
        let postCount = Counter()
        var registry: [Hook] = []
        registry.append(try postToolUse { _ in await postCount.increment() })
        let handler: BackgroundClientToolHandler = { _, job in
            await job.ack()
            do {
                try await job.complete(summary: "first try")
            } catch {
                await firstError.set(error.localizedDescription)
            }
            try await job.complete(summary: "second try")
        }

        _ = await invokeBackgroundClientToolHandler(
            handler, tool: "export", payload: "{}", sink: sink,
            hooks: HookEngine(registry), sessionId: "s1"
        )
        await sink.drain()

        #expect(await firstError.value == "data channel closed")
        let published = await flaky.published
        #expect(published.count == 1)
        #expect(published.first?.summary == "second try")
        #expect(await postCount.value == 1)
    }

    @Test("PreToolUse deny blocks a background tool and fires PostToolUse .denied")
    func backgroundDenyFiresPostDenied() async throws {
        let capture = Capture()
        let sink = makeSink(capture)
        let handlerRan = CaptureBox<Bool>()
        let postBox = CaptureBox<ToolOutcome>()
        var registry: [Hook] = []
        registry.append(try preToolUse { _ in
            PreToolUseResult(permission: .deny, reason: "no exports")
        })
        registry.append(try postToolUse { ctx in await postBox.set(ctx.outcome) })
        let handler: BackgroundClientToolHandler = { _, _ in
            await handlerRan.set(true)
        }

        let reply = decode(await invokeBackgroundClientToolHandler(
            handler, tool: "export", payload: "{}", sink: sink,
            hooks: HookEngine(registry), sessionId: "s1"
        ))

        #expect(reply["ok"] == .bool(false))
        #expect(reply["error"] == .string("no exports"))
        #expect(await handlerRan.value == nil)
        #expect(await postBox.value == .denied("no exports"))
        #expect(await capture.results.isEmpty)
    }
}
