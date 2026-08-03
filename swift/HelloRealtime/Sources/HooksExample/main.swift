import CosmoRealtime
import Foundation

// Live proof of all four hooks in one session: SessionStart (inject caller
// context), PreToolUse/deny (block delete_account), PreToolUse/rewrite
// (force account=primary on get_account_balance), PostToolUse (observe
// outcome), SessionEnd (observe exit reason).
//
// Run:
//   COSMO_API_KEY=... COSMO_BASE_URL=https://app.askcosmo.ai swift run HooksExample
//
// Optional env overrides:
//   COSMO_HOOKS_PROMPT1  — first user turn  (default: balance query)
//   COSMO_HOOKS_PROMPT2  — second user turn (default: delete request)
//
// Each ◆ HOOK line proves the corresponding hook fired. The delete_account
// ▶ handler line must NOT appear — the PreToolUse/deny hook suppresses it.

func env(_ key: String) -> String {
    guard let v = ProcessInfo.processInfo.environment[key], !v.isEmpty else {
        fputs("error: set \(key)\n", stderr)
        exit(1)
    }
    return v
}

let apiKey = env("COSMO_API_KEY")
guard let baseURL = URL(string: env("COSMO_BASE_URL")) else {
    fputs("error: COSMO_BASE_URL is not a valid URL\n", stderr)
    exit(1)
}

let prompt1 = ProcessInfo.processInfo.environment["COSMO_HOOKS_PROMPT1"]
    ?? "Hi, what's the balance on my checking account?"
let prompt2 = ProcessInfo.processInfo.environment["COSMO_HOOKS_PROMPT2"]
    ?? "Okay, please permanently delete my account."

// The first turn must be sent only after the agent is live (`.ready`);
// turns sent earlier are dropped.
actor ReadyFlag {
    private var ready = false
    func set() { ready = true }
    func get() -> Bool { ready }
}
let readyFlag = ReadyFlag()

// MARK: - Client tools

let getBalanceTool = SessionConfig.Tool.client(
    name: "get_account_balance",
    description: "Return the balance for a named account.",
    parameters: [
        "type": .string("object"),
        "properties": .object(["account": .object(["type": .string("string")])]),
    ],
    handler: { args in
        print("▶ handler get_account_balance ran args=\(args)")
        let account = args["account"] ?? .string("primary")
        return ["balance": .string("$1,240.00"), "account": account]
    }
)

let deleteAccountTool = SessionConfig.Tool.client(
    name: "delete_account",
    description: "Permanently delete the user's account.",
    parameters: [
        "type": .string("object"),
        "properties": .object([:]),
    ],
    handler: { _ in
        print("▶ handler delete_account ran — SHOULD NOT APPEAR")
        return [:]
    }
)

// MARK: - Hooks

@Sendable func describeOutcome(_ outcome: ToolOutcome) -> String {
    switch outcome {
    case .ok: return "ok"
    case .error(let m): return "error(\(m))"
    case .denied(let r): return "denied(\(r))"
    }
}

let hooks: [Hook] = [
    sessionStart { _ in
        print("◆ HOOK SessionStart — injecting caller context")
        return SessionStartResult(additionalContext: "The caller is Ada Lovelace. Greet her by name once, briefly.")
    },
    try preToolUse(matcher: "delete_*") { ctx in
        print("◆ HOOK PreToolUse — DENY \(ctx.toolName)")
        return PreToolUseResult(permission: .deny, reason: "account deletion is disabled in this demo")
    },
    try preToolUse(matcher: "get_*") { ctx in
        print("◆ HOOK PreToolUse — rewrite args for \(ctx.toolName) → account=primary")
        return PreToolUseResult(updatedArguments: ["account": .string("primary")])
    },
    try postToolUse { ctx in
        print("◆ HOOK PostToolUse — \(ctx.toolName) outcome=\(describeOutcome(ctx.outcome))")
    },
    sessionEnd { ctx in
        print("◆ HOOK SessionEnd — reason=\(ctx.reason.rawValue)" + (ctx.detail.map { " detail=\($0)" } ?? ""))
    },
]

// MARK: - Session

let agent = try Agent(tools: [getBalanceTool, deleteAccountTool], hooks: hooks)

let options = RealtimeSession.Options(apiKey: apiKey, baseURL: baseURL)
let config = SessionConfig(instructions: "You are a concise bank phone-support agent. Keep replies short.")

print("connecting to \(baseURL.absoluteString)…")
let session = try await agent.start(options, config: config, micMuted: true)

let pump = Task {
    do {
        for try await event in session.session.events {
            switch event {
            case .ready:
                print("● READY — session live")
                await readyFlag.set()
            case .transcript(let t):
                print("  [\(t.role)] \(t.text)" + (t.isFinal ? "" : " …"))
            case .modelText(let m):
                print("  [model] \(m.text)")
            case .toolCall(let call):
                print("● TOOL CALL: \(call.name)")
            case .toolResult(let r):
                print("● TOOL RESULT: ok=\(r.ok)" + (r.summary.map { " — \($0)" } ?? ""))
            case .turnComplete:
                print("● TURN COMPLETE")
            case .error(let e):
                print("● ERROR \(e.code): \(e.message)")
            case .sessionEnded(let ended):
                print("● SESSION ENDED" + (ended.reason.map { ": \($0)" } ?? ""))
                return
            default:
                break
            }
        }
    } catch {
        print("● stream error: \(error)")
    }
}

// Wait (up to 60s) for `.ready` before the first turn.
for _ in 0..<120 {
    if await readyFlag.get() { break }
    try await Task.sleep(nanoseconds: 500_000_000)
}
if await readyFlag.get() {
    print("agent live — sending turns")
} else {
    print("⚠️ timed out waiting for READY (worker busy?) — sending anyway")
}

print("\n> user: \(prompt1)\n")
try await session.session.send(text: prompt1)

try await Task.sleep(nanoseconds: 14_000_000_000)
print("\n> user: \(prompt2)\n")
try await session.session.send(text: prompt2)

try await Task.sleep(nanoseconds: 14_000_000_000)
print("\nending…")
await session.end()
pump.cancel()
print("done.")
