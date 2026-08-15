import Foundation
import Testing
@testable import CosmoRealtime

@Suite("SessionConfig.hooks")
struct SessionConfigHooksTests {

    // 1a. == ignores hooks: configs with identical wire fields but different
    //     hooks (nil vs non-nil) compare equal.
    @Test("== ignores hooks — nil vs non-nil registry")
    func equalityIgnoresHooksNilVsNonNil() {
        var registry: [Hook] = []
        registry.append(sessionStart { _ in SessionStartResult(additionalContext: "ctx") })

        let withHooks = SessionConfig(instructions: "hello", hooks: registry)
        let withoutHooks = SessionConfig(instructions: "hello", hooks: nil)
        #expect(withHooks == withoutHooks)
    }

    // 1b. == ignores hooks: a config equals a copy of itself that only
    //     differs in hooks.
    @Test("== ignores hooks — copy differing only in hooks")
    func equalityIgnoresHooksCopyDiffers() {
        var registryA: [Hook] = []
        registryA.append(sessionStart { _ in SessionStartResult(additionalContext: "A") })

        var registryB: [Hook] = []
        registryB.append(sessionStart { _ in SessionStartResult(additionalContext: "B") })

        let configA = SessionConfig(model: "gemini-live", instructions: "sys", hooks: registryA)
        let configB = SessionConfig(model: "gemini-live", instructions: "sys", hooks: registryB)
        #expect(configA == configB)
    }

    // 2. == still distinguishes wire fields: configs differing only in
    //    instructions are NOT equal.
    @Test("== distinguishes wire fields — instructions differ")
    func equalityDistinguishesWireFields() {
        let a = SessionConfig(instructions: "be brief")
        let b = SessionConfig(instructions: "be verbose")
        #expect(a != b)
    }

    // 3a. resolving inherits hooks from defaults when per-call hooks is nil.
    // 3b. resolving: per-call hooks win over defaults when set.
}
