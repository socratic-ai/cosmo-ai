import Foundation
import Testing
@testable import CosmoRealtime

// Counter actor for tracking side-effects from @Sendable closures in Swift 6.
@Suite struct HooksTests {

    // 1. runSessionStart concatenates additionalContext in registration order.
    @Test
    func sessionStartConcatenatesContextInOrder() async {
        var registry: [Hook] = []
        registry.append(sessionStart { _ in SessionStartResult(additionalContext: "first") })
        registry.append(sessionStart { _ in SessionStartResult(additionalContext: "second") })
        registry.append(sessionStart { _ in SessionStartResult(additionalContext: nil) })
        registry.append(sessionStart { _ in SessionStartResult(additionalContext: "third") })

        let result = await HookEngine(registry).runSessionStart()
        #expect(result == "first\n\nsecond\n\nthird")
    }

    // 1b. runSessionStart returns nil when no hook yields context.
    @Test
    func sessionStartReturnsNilWhenNoContext() async {
        var registry: [Hook] = []
        registry.append(sessionStart { _ in nil })
        registry.append(sessionStart { _ in SessionStartResult(additionalContext: nil) })
        registry.append(sessionStart { _ in SessionStartResult(additionalContext: "") })

        let result = await HookEngine(registry).runSessionStart()
        #expect(result == nil)
    }

    // 2. runPreToolUse first-deny-wins: the later hook must NOT run.
    @Test
    func preToolUseFirstDenyWinsAndShortCircuits() async throws {
        let counter = Counter()
        var registry: [Hook] = []

        registry.append(try preToolUse { _ in
            PreToolUseResult(permission: .deny, reason: "no access")
        })
        registry.append(try preToolUse { _ in
            await counter.increment()
            return nil
        })

        let outcome = await HookEngine(registry).runPreToolUse(
            toolName: "delete_file",
            arguments: ["path": .string("/tmp/x")],
            sessionId: "sess-test"
        )

        #expect(outcome.denied == true)
        #expect(outcome.reason == "no access")
        let seen = await counter.value
        #expect(seen == 0)
    }

    // 3. runPreToolUse: sequential arg transforms — hook 2 sees hook 1's output.
    @Test
    func preToolUseSequentialArgTransforms() async throws {
        var registry: [Hook] = []
        let capturedArgsBox = CaptureBox<[String: JSONValue]>()

        registry.append(try preToolUse { ctx in
            var args = ctx.arguments
            args["injected"] = .string("yes")
            return PreToolUseResult(updatedArguments: args)
        })
        registry.append(try preToolUse { ctx in
            await capturedArgsBox.set(ctx.arguments)
            return nil
        })

        _ = await HookEngine(registry).runPreToolUse(
            toolName: "some_tool",
            arguments: ["original": .bool(true)],
            sessionId: "sess-test"
        )

        let capturedArgs = await capturedArgsBox.value
        #expect(capturedArgs?["injected"] == .string("yes"))
        #expect(capturedArgs?["original"] == .bool(true))
    }

    // 4. runPreToolUse matcher filters by tool name.
    @Test
    func preToolUseMatcherFiltersToolName() async throws {
        var registry: [Hook] = []

        // deny hook only fires for tools matching "delete_*"
        registry.append(try preToolUse(matcher: "delete_*") { _ in
            PreToolUseResult(permission: .deny, reason: "blocked")
        })

        let deniedOutcome = await HookEngine(registry).runPreToolUse(
            toolName: "delete_x",
            arguments: [:],
            sessionId: "sess-test"
        )
        let allowedOutcome = await HookEngine(registry).runPreToolUse(
            toolName: "read_x",
            arguments: [:],
            sessionId: "sess-test"
        )

        #expect(deniedOutcome.denied == true)
        #expect(allowedOutcome.denied == false)
    }

    // 5. A throwing hook is isolated — skipped, sibling still runs.
    @Test
    func throwingHookIsIsolatedAndSiblingRuns() async throws {
        let counter = Counter()
        var registry: [Hook] = []

        struct TestError: Error {}

        registry.append(try preToolUse { _ in throw TestError() })
        registry.append(try preToolUse { _ in
            await counter.increment()
            return nil
        })

        let outcome = await HookEngine(registry).runPreToolUse(
            toolName: "any_tool",
            arguments: [:],
            sessionId: "sess-test"
        )

        #expect(outcome.denied == false)
        let seen = await counter.value
        #expect(seen == 1)
    }

    // 6. runPostToolUse observes the outcome.
    @Test
    func postToolUseObservesOutcome() async throws {
        var registry: [Hook] = []
        let capturedBox = CaptureBox<ToolOutcome>()

        registry.append(try postToolUse { ctx in
            await capturedBox.set(ctx.outcome)
        })

        let ctx = PostToolUseContext(
            toolName: "read_file",
            arguments: [:],
            outcome: .error("disk error"),
            sessionId: "sess-1"
        )
        await HookEngine(registry).runPostToolUse(ctx)

        let seen = await capturedBox.value
        #expect(seen == .error("disk error"))
    }

    // 7. runSessionEnd: throwing hook is isolated — sibling still runs.
    @Test
    func sessionEndHookIsolatesThrows() async {
        let counter = Counter()
        var registry: [Hook] = []

        struct BoomError: Error {}

        registry.append(sessionEnd { _ in throw BoomError() })
        registry.append(sessionEnd { _ in
            await counter.increment()
        })

        await HookEngine(registry).runSessionEnd(SessionEndContext(reason: .clientEnded, detail: nil, sessionId: "s1"))

        #expect(await counter.value == 1)
    }

    // 8. A malformed matcher (unterminated '[') is rejected at registration —
    //    it would otherwise silently never match (fail-open for deny guards).
    @Test(arguments: ["[delete_*", "tool[0-9", "[!abc", "prefix_[a-z"])
    func malformedMatcherRejectedAtRegistration(pattern: String) {
        var registry: [Hook] = []
        #expect(throws: MalformedHookMatcherError.self) {
            registry.append(try preToolUse(matcher: pattern) { _ in nil })
        }
        #expect(throws: MalformedHookMatcherError.self) {
            registry.append(try postToolUse(matcher: pattern) { _ in })
        }
    }

    // 8b. Well-formed matchers, including bracket groups, register fine.
    @Test(arguments: ["", "*", "tool_?", "tool_[0-9]", "tool_[!ab]"])
    func wellFormedMatcherAcceptedAtRegistration(pattern: String) throws {
        var registry: [Hook] = []
        registry.append(try preToolUse(matcher: pattern) { _ in nil })
        registry.append(try postToolUse(matcher: pattern) { _ in })
    }

    // 9. An empty-string deny reason folds to the default, matching the
    //    reference's `reason or "denied by hook"`.
    @Test
    func preToolUseEmptyDenyReasonFoldsToDefault() async throws {
        var registry: [Hook] = []
        registry.append(try preToolUse { _ in
            PreToolUseResult(permission: .deny, reason: "")
        })

        let outcome = await HookEngine(registry).runPreToolUse(
            toolName: "any_tool",
            arguments: [:],
            sessionId: "sess-test"
        )

        #expect(outcome.denied == true)
        #expect(outcome.reason == "denied by hook")
    }
}

// Sendable capture box for test side-effects.