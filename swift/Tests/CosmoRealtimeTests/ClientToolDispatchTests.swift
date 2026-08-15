import Foundation
import Testing
@testable import CosmoRealtime

@Suite("Client-tool dispatch")
struct ClientToolDispatchTests {

    private func decode(_ envelope: String) -> [String: JSONValue] {
        guard
            case .object(let fields)? = try? JSONDecoder().decode(
                JSONValue.self, from: Data(envelope.utf8)
            )
        else {
            Issue.record("reply envelope was not a JSON object: \(envelope)")
            return [:]
        }
        return fields
    }

    @Test("a successful handler maps to {ok: true, result}")
    func successEnvelope() async {
        let handler: ClientToolHandler = { args in
            #expect(args["q"] == .string("now"))
            return ["iso": .string("2026-06-23T10:00:00Z")]
        }
        let reply = await invokeClientToolHandler(
            handler, tool: "test_tool", payload: #"{"q":"now"}"#, hooks: nil, sessionId: nil
        )
        let fields = decode(reply)
        #expect(fields["ok"] == .bool(true))
        #expect(fields["result"] == .object(["iso": .string("2026-06-23T10:00:00Z")]))
        #expect(fields["error"] == .null)
    }

    @Test("an empty payload runs the handler with empty args")
    func emptyPayloadIsEmptyArgs() async {
        let handler: ClientToolHandler = { args in
            #expect(args.isEmpty)
            return ["ok": .bool(true)]
        }
        let fields = decode(await invokeClientToolHandler(
            handler, tool: "test_tool", payload: "", hooks: nil, sessionId: nil
        ))
        #expect(fields["ok"] == .bool(true))
    }

    @Test("non-JSON args fail closed without running the handler")
    func nonJsonArgs() async {
        let handler: ClientToolHandler = { _ in
            Issue.record("handler must not run on undecodable args")
            return [:]
        }
        let fields = decode(await invokeClientToolHandler(
            handler, tool: "test_tool", payload: "not json", hooks: nil, sessionId: nil
        ))
        #expect(fields["ok"] == .bool(false))
        if case .string(let message)? = fields["error"] {
            #expect(message.contains("valid JSON"))
        } else {
            Issue.record("expected an error string")
        }
    }

    @Test("non-object args fail closed")
    func nonObjectArgs() async {
        let handler: ClientToolHandler = { _ in [:] }
        let fields = decode(await invokeClientToolHandler(
            handler, tool: "test_tool", payload: "[1,2,3]", hooks: nil, sessionId: nil
        ))
        #expect(fields["ok"] == .bool(false))
        if case .string(let message)? = fields["error"] {
            #expect(message.contains("JSON object"))
        } else {
            Issue.record("expected an error string")
        }
    }

    @Test("a throwing handler maps to {ok: false, error}")
    func throwingHandler() async {
        struct ToolError: Error, LocalizedError {
            var errorDescription: String? { "tool blew up" }
        }
        let handler: ClientToolHandler = { _ in throw ToolError() }
        let fields = decode(await invokeClientToolHandler(
            handler, tool: "test_tool", payload: "{}", hooks: nil, sessionId: nil
        ))
        #expect(fields["ok"] == .bool(false))
        #expect(fields["error"] == .string("tool blew up"))
    }

    @Test("an oversized success result is delivered truncated, not lost")
    func oversizedResult() async {
        let big = String(repeating: "x", count: 20 * 1024)
        let handler: ClientToolHandler = { _ in
            ["blob": .string(big), "unit": .string("celsius")]
        }
        let reply = await invokeClientToolHandler(
            handler, tool: "test_tool", payload: "{}", hooks: nil, sessionId: nil
        )
        #expect(reply.utf8.count <= ClientToolReply.maxBytes)
        let fields = decode(reply)
        #expect(fields["ok"] == .bool(true))
        #expect(fields["error"] == .null)
        guard case .object(let result)? = fields["result"] else {
            Issue.record("expected a result object")
            return
        }
        // The partial answer survives, and the marker tells the model it is partial.
        guard case .object(let marker)? = result[ClientToolReply.truncationMarkerKey] else {
            Issue.record("expected a truncation marker object")
            return
        }
        #expect(marker["note"] == .string(ClientToolReply.truncationMarkerNote))
        if case .int(let kept)? = marker["kept_bytes"],
            case .int(let original)? = marker["original_bytes"] {
            #expect(original > kept && kept > 0)
        } else {
            Issue.record("expected an integer byte pair on the marker")
        }
        #expect(result["unit"] == .string("celsius"))
        guard case .string(let blob)? = result["blob"] else {
            Issue.record("expected the oversized field to survive as a truncated string")
            return
        }
        #expect(blob.hasPrefix("xxx"))
        #expect(blob.hasSuffix(ClientToolReply.truncationSuffix))
        #expect(blob.utf8.count < big.utf8.count)
    }

    /// The shape the never-grow rule exists for: short strings near the
    /// suffix's own length beside one long string.
    private static func interiorWindowResult() -> [String: JSONValue] {
        var result: [String: JSONValue] = [:]
        for i in 0..<20 { result["k\(i)"] = .string(String(repeating: "a", count: 8)) }
        result["big"] = .string(String(repeating: "b", count: 32_768))
        result["pad"] = .array(Array(repeating: .int(0), count: 4_905))
        return result
    }

    @Test("many short strings beside a long one keep every entry")
    func interiorWindowKeepsEveryEntry() {
        let result = Self.interiorWindowResult()
        let built = clientToolSuccessReply(result)
        #expect(built.truncated)
        #expect(built.reply.utf8.count <= ClientToolReply.maxBytes)
        // Nearly the whole budget is spent on the answer, not surrendered.
        #expect(built.reply.utf8.count > ClientToolReply.maxBytes - 512)
        guard case .object(let fields)? = decode(built.reply)["result"] else {
            Issue.record("expected a result object")
            return
        }
        #expect(
            Set(fields.keys)
                == Set(result.keys).union([ClientToolReply.truncationMarkerKey])
        )
    }

    /// The property ``clientToolSuccessReply``'s binary search prunes on.
    /// Without it a smaller allowance can yield a larger reply, and the search
    /// steps over the fitting window and reports that nothing fits.
    @Test("the shortened size never falls as the allowance rises")
    func shortenedSizeRisesMonotonically() {
        let result = Self.interiorWindowResult()
        let sizes = (0..<120).map { allowance in
            ClientToolReply.envelope(
                ok: true,
                result: {
                    guard case .object(let shrunk) = shrinkStrings(
                        .object(result), maxScalars: allowance
                    ) else { return [:] }
                    return shrunk
                }()
            ).utf8.count
        }
        #expect(sizes == sizes.sorted())
    }

    /// Astral scalars survive whole. ``String/prefix(_:)`` counts grapheme
    /// clusters and would land somewhere the sibling SDKs do not.
    @Test("an error message is cut on a scalar boundary")
    func errorMessageCutsOnScalarBoundary() {
        let reply = clientToolErrorReply(String(repeating: "🙂", count: 20_000))
        #expect(reply.utf8.count <= ClientToolReply.maxBytes)
        guard case .string(let message)? = decode(reply)["error"] else {
            Issue.record("expected an error string")
            return
        }
        #expect(message.hasSuffix(ClientToolReply.truncationSuffix))
        let kept = String(message.dropLast(ClientToolReply.truncationSuffix.count))
        #expect(kept == String(repeating: "🙂", count: kept.unicodeScalars.count))
    }

    /// Ranking on the value alone drops the wrong entry, then runs out of
    /// entries and returns nothing but the marker.
    @Test("a long key is weighed with its value when dropping entries")
    func longKeyIsWeighedWithItsValue() {
        let longKey = String(repeating: "K", count: 15_200)
        let built = clientToolSuccessReply([
            longKey: .int(0),
            "x": .array(Array(repeating: .int(0), count: 100)),
        ])
        #expect(built.reply.utf8.count <= ClientToolReply.maxBytes)
        guard case .object(let fields)? = decode(built.reply)["result"] else {
            Issue.record("expected a result object")
            return
        }
        #expect(fields["x"] == .array(Array(repeating: .int(0), count: 100)))
        #expect(fields[longKey] == nil)
    }

    @Test("a result that is oversized without long strings drops entries, biggest first")
    func oversizedNonStringResult() async {
        // No string is long enough to shrink — the bytes are in the array.
        let numbers = JSONValue.array((0..<4000).map { .int(1_000_000 + $0) })
        let handler: ClientToolHandler = { _ in ["rows": numbers, "count": .int(4000)] }
        let reply = await invokeClientToolHandler(
            handler, tool: "test_tool", payload: "{}", hooks: nil, sessionId: nil
        )
        #expect(reply.utf8.count <= ClientToolReply.maxBytes)
        let fields = decode(reply)
        #expect(fields["ok"] == .bool(true))
        guard case .object(let result)? = fields["result"] else {
            Issue.record("expected a result object")
            return
        }
        #expect(result["rows"] == nil)
        #expect(result["count"] == .int(4000))
        guard case .object(let marker)? = result[ClientToolReply.truncationMarkerKey] else {
            Issue.record("expected a truncation marker object")
            return
        }
        #expect(marker["note"] == .string(ClientToolReply.truncationMarkerNote))
        // The dropped array is the whole overflow, so almost nothing survived.
        if case .int(let kept)? = marker["kept_bytes"],
            case .int(let original)? = marker["original_bytes"] {
            #expect(original > 10 * kept)
        } else {
            Issue.record("expected an integer byte pair on the marker")
        }
    }

    @Test("a result that fits is passed through unchanged and unmarked")
    func fittingResultIsNotMarked() {
        let built = clientToolSuccessReply(["temp_c": .double(21.5)])
        #expect(!built.truncated)
        let fields = decode(built.reply)
        #expect(fields["result"] == .object(["temp_c": .double(21.5)]))
    }

    @Test("an oversized ack note is truncated so the deferred reply fits the cap")
    func oversizedDeferredNote() {
        let reply = clientToolDeferredReply(
            jobId: "job-1", note: String(repeating: "n", count: 30 * 1024)
        )
        #expect(reply.utf8.count <= ClientToolReply.maxBytes)
        let fields = decode(reply)
        #expect(fields["ok"] == .bool(true))
        #expect(fields["deferred"] == .bool(true))
        #expect(fields["job_id"] == .string("job-1"))
        guard case .object(let result)? = fields["result"],
            case .string(let note)? = result["note"]
        else {
            Issue.record("expected a truncated ack note")
            return
        }
        #expect(note.hasSuffix(ClientToolReply.truncationSuffix))
    }

    @Test("only the matching agent participant may invoke a client tool")
    func callerGuardAuthorizesOnlyTheAgent() {
        // The agent whose identity matches the caller is authorized.
        #expect(
            isAuthorizedClientToolCaller(
                callerIdentity: "agent-1",
                participants: [("agent-1", true)]
            )
        )
        // A matching identity that is not an agent is rejected.
        #expect(
            !isAuthorizedClientToolCaller(
                callerIdentity: "human-1",
                participants: [("human-1", false)]
            )
        )
        // No participants (e.g. room torn down) authorizes no one.
        #expect(!isAuthorizedClientToolCaller(callerIdentity: "agent-1", participants: []))
        // An agent is present but the caller is a different identity.
        #expect(
            !isAuthorizedClientToolCaller(
                callerIdentity: "human-1",
                participants: [("agent-1", true)]
            )
        )
        // The caller identity matches a NON-agent while a different agent
        // exists — must not authorize (the same participant must be both
        // the caller and an agent).
        #expect(
            !isAuthorizedClientToolCaller(
                callerIdentity: "shared",
                participants: [("shared", false), ("agent-1", true)]
            )
        )
        // Mixed room: the matching agent among several participants is
        // authorized.
        #expect(
            isAuthorizedClientToolCaller(
                callerIdentity: "agent-1",
                participants: [("human-1", false), ("agent-1", true), ("human-2", false)]
            )
        )
    }

    @Test("an oversized error message is truncated to fit the reply cap")
    func errorTruncation() {
        let reply = clientToolErrorReply(String(repeating: "e", count: 30 * 1024))
        #expect(reply.utf8.count <= ClientToolReply.maxBytes)
        let fields = decode(reply)
        #expect(fields["ok"] == .bool(false))
        if case .string(let message)? = fields["error"] {
            #expect(message.hasSuffix(ClientToolReply.truncationSuffix))
        } else {
            Issue.record("expected a truncated error string")
        }
    }

    // MARK: – Hook integration

    @Test("PreToolUse deny skips handler and PostToolUse fires with .denied")
    func hookDenySkipsHandlerAndFiresPostDenied() async throws {
        let handlerCalled = CaptureBox<Bool>()
        let handler: ClientToolHandler = { _ in
            await handlerCalled.set(true)
            return [:]
        }
        let postOutcomeBox = CaptureBox<ToolOutcome>()
        var registry: [Hook] = []
        registry.append(try preToolUse { _ in PreToolUseResult(permission: .deny, reason: "blocked") })
        registry.append(try postToolUse { ctx in await postOutcomeBox.set(ctx.outcome) })

        let fields = decode(await invokeClientToolHandler(
            handler, tool: "my_tool", payload: "{}", hooks: HookEngine(registry), sessionId: "s1"
        ))
        #expect(fields["ok"] == .bool(false))
        if case .string(let msg)? = fields["error"] {
            #expect(msg == "blocked")
        } else {
            Issue.record("expected error string 'blocked'")
        }
        #expect(await handlerCalled.value == nil)
        let postOutcome = await postOutcomeBox.value
        #expect(postOutcome == .denied("blocked"))
    }

    @Test("PreToolUse rewrite reaches handler with updated args")
    func hookRewriteReachesHandler() async throws {
        let receivedArgsBox = CaptureBox<[String: JSONValue]>()
        let handler: ClientToolHandler = { args in
            await receivedArgsBox.set(args)
            return [:]
        }
        var registry: [Hook] = []
        registry.append(try preToolUse { ctx in
            var args = ctx.arguments
            args["injected"] = .string("yes")
            return PreToolUseResult(updatedArguments: args)
        })

        _ = await invokeClientToolHandler(
            handler, tool: "my_tool", payload: #"{"original":true}"#, hooks: HookEngine(registry), sessionId: "s1"
        )
        let received = await receivedArgsBox.value
        #expect(received?["injected"] == .string("yes"))
        #expect(received?["original"] == .bool(true))
    }

    @Test("successful call fires PostToolUse with .ok(result)")
    func hookPostToolUseSuccess() async throws {
        let handler: ClientToolHandler = { _ in ["answer": .string("42")] }
        let postOutcomeBox = CaptureBox<ToolOutcome>()
        var registry: [Hook] = []
        registry.append(try postToolUse { ctx in await postOutcomeBox.set(ctx.outcome) })

        _ = await invokeClientToolHandler(
            handler, tool: "my_tool", payload: "{}", hooks: HookEngine(registry), sessionId: "s1"
        )
        let outcome = await postOutcomeBox.value
        if case .ok(let result)? = outcome {
            #expect(result?["answer"] == .string("42"))
        } else {
            Issue.record("expected .ok outcome, got \(String(describing: outcome))")
        }
    }

    @Test("oversized result fires PostToolUse with .ok carrying the untruncated result")
    func hookPostToolUseOversizedIsOk() async throws {
        let big = String(repeating: "x", count: 20 * 1024)
        let handler: ClientToolHandler = { _ in ["blob": .string(big)] }
        let postOutcomeBox = CaptureBox<ToolOutcome>()
        var registry: [Hook] = []
        registry.append(try postToolUse { ctx in await postOutcomeBox.set(ctx.outcome) })

        let fields = decode(await invokeClientToolHandler(
            handler, tool: "my_tool", payload: "{}", hooks: HookEngine(registry), sessionId: "s1"
        ))
        #expect(fields["ok"] == .bool(true))
        // The cap is a transport property; a local observer sees what the
        // handler actually returned, not what fit on the wire.
        let outcome = await postOutcomeBox.value
        if case .ok(let result)? = outcome {
            #expect(result?["blob"] == .string(big))
        } else {
            Issue.record("expected .ok outcome for oversized result, got \(String(describing: outcome))")
        }
    }

    @Test("nil hooks does not change behavior (no-hooks path)")
    func nilHooksNoChange() async {
        let handler: ClientToolHandler = { _ in ["val": .bool(true)] }
        let fields = decode(await invokeClientToolHandler(
            handler, tool: "my_tool", payload: "{}", hooks: nil, sessionId: nil
        ))
        #expect(fields["ok"] == .bool(true))
    }

    @Test("hooks are skipped when there is no session id")
    func hooksSkippedWithoutSessionId() async throws {
        let handlerCalled = CaptureBox<Bool>()
        let handler: ClientToolHandler = { _ in
            await handlerCalled.set(true)
            return [:]
        }
        let preFired = CaptureBox<Bool>()
        var registry: [Hook] = []
        registry.append(try preToolUse { _ in
            await preFired.set(true)
            return PreToolUseResult(permission: .deny, reason: "blocked")
        })

        let fields = decode(await invokeClientToolHandler(
            handler, tool: "my_tool", payload: "{}", hooks: HookEngine(registry), sessionId: nil
        ))

        #expect(fields["ok"] == .bool(true))
        #expect(await handlerCalled.value == true)
        #expect(await preFired.value == nil)
    }
}
