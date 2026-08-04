import CosmoRealtime
import Foundation

// A headless live proof of the Agent + Skills loop: declare one hot skill,
// open a real session through the Agent, send a user turn as text, and watch
// the model call `load_skill` and follow the body.
//
//   COSMO_API_KEY=... \
//     swift run SkillsExample
//
// Optional: COSMO_SKILL_PROMPT to override the opening user turn.

func env(_ key: String) -> String {
    guard let v = ProcessInfo.processInfo.environment[key], !v.isEmpty else {
        fputs("error: set \(key)\n", stderr)
        exit(1)
    }
    return v
}

let apiKey = env("COSMO_API_KEY")
let prompt = ProcessInfo.processInfo.environment["COSMO_SKILL_PROMPT"]
    ?? "I just got my new card in the mail. How do I activate it?"

// Normally a SKILL.md on disk; inlined here so the example is self-contained.
let skillMarkdown = """
---
name: activate-card
description: Activate a newly received card
tier: hot
---
When the user wants to activate a card, ask whether they will use the website
or the mobile app, then give the matching two-step flow. Ask one question at a
time and keep replies short.
"""
let skills = [try parseSkillMd(skillMarkdown, defaultName: "activate-card")]
let agent = try Agent(skills: skills)

print("== resident menu (appended to instructions) ==")
print(skillsMenuText(skills))
print("==============================================\n")

let options = RealtimeSession.Options(apiKey: apiKey)
let config = SessionConfig(instructions: "You are Alex, a concise phone support agent.")

print("connecting to \(options.baseURL.absoluteString)…")
let session = try await agent.start(options, config: config, micMuted: true)

let pump = Task {
    do {
        for try await event in session.session.events {
            switch event {
            case .ready:
                print("● READY — session live")
            case .transcript(let t):
                print("  [\(t.role)] \(t.text)" + (t.isFinal ? "" : " …"))
            case .modelText(let m):
                print("  [model] \(m.text)")
            case .toolCall(let call):
                let hit = call.name == loadSkillToolName ? "   ⟵ SKILL LOADED ✅" : ""
                print("● TOOL CALL: \(call.name)\(hit)")
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

// Let the agent come up before the first turn (sending instantly races ready).
try await Task.sleep(nanoseconds: 2_500_000_000)
print("\n> user: \(prompt)\n")
try await session.session.send(text: prompt)

try await Task.sleep(nanoseconds: 12_000_000_000)
print("\nending session…")
await session.end()
pump.cancel()
print("done.")
