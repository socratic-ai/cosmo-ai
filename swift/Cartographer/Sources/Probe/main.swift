import Foundation
import CosmoRealtime

// Headless text-only probe: connect, declare one client tool, send a line,
// prove the tool round-trips, hang up. Mirrors the docs quickstart minus mic.
//
// Writes to stderr because Swift's `print` is block-buffered when stdout is a
// pipe, which makes a live realtime session look like a hang.
func say(_ s: String) { fputs(s + "\n", stderr) }

let key = ProcessInfo.processInfo.environment["COSMO_API_KEY"] ?? ""
guard !key.isEmpty else { say("set COSMO_API_KEY"); exit(1) }

actor Collected {
    private(set) var ideas: [String] = []
    func add(_ s: String) { ideas.append(s) }
}
let collected = Collected()

struct Args: Decodable, Sendable {
    let idea: String
    let parent: String?
}

let addIdea = try SessionConfig.Tool.define(
    name: "add_idea",
    description: "Put one idea on the user's visible mind map. Call immediately for each idea.",
    input: .object(
        properties: [
            "idea": .string(description: "The idea, 1-5 words."),
            "parent": .string(description: "Existing idea it hangs off. Omit for a root."),
        ],
        required: ["idea"]
    )
) { (args: Args) -> [String: JSONValue] in
    await collected.add(args.idea)
    say("  ▶ add_idea(\"\(args.idea)\", parent: \(args.parent ?? "—"))")
    return ["id": .string(args.idea.lowercased().replacingOccurrences(of: " ", with: "-"))]
}

let options = RealtimeSession.Options(apiKey: key)
say("connecting to \(options.baseURL.host ?? "?") …")
let t0 = Date()

let session = try await RealtimeSession.start(
    options,
    config: SessionConfig(
        audio: .init(
            output: ProcessInfo.processInfo.environment["NO_AUDIO"] == "1" ? false : nil
        ),
        instructions: """
        You draw a mind map from what the user says. Call add_idea for every \
        idea, immediately, before replying. Then reply in one short sentence.
        """,
        tools: [addIdea]
    ),
    micMuted: true
)
say("start() returned in \(String(format: "%.2f", Date().timeIntervalSince(t0)))s")

let stateWatch = Task {
    for await state in session.states {
        say("  [state] \(state) @\(String(format: "%.2f", Date().timeIntervalSince(t0)))s")
    }
}

let pump = Task {
    for try await event in session.events {
        switch event {
        case .ready(let r):
            say("ready at \(String(format: "%.2f", Date().timeIntervalSince(t0)))s — session \(r.sessionId)")
            for rej in r.rejectedTools ?? [] { say("  ⚠︎ server rejected tool: \(rej.name)") }
            try await session.send(
                text: "I'm thinking about a weekend trip: either Vermont for hiking, "
                    + "or Montreal for food. Budget is tight and I only have two days."
            )
        case .transcript(let d) where d.isFinal:
            say("[\(d.role == .user ? "you" : "cosmo")] \(d.text)")
        case .modelText(let m):
            say("[cosmo/text] \(m.text)")
        case .toolInvocation(let t):
            say("  · invocation: \(t.name)")
        case .turnComplete:
            say("— turn complete —")
            return
        case .error(let e):
            say("  ✗ error [\(e.code.rawValue)] \(e.message)")
        case .sessionEnded(let e):
            say("ended: \(e.reason ?? "—")")
            return
        case .unknown(let t, _):
            say("  ? unknown event: \(t ?? "<opaque>")")
        default:
            break
        }
    }
}

// Bound the run ourselves — the SDK has no "await this session's completion".
let watchdog = Task {
    try? await Task.sleep(nanoseconds: 45_000_000_000)
    if !pump.isCancelled { say("!! watchdog fired at 60s"); pump.cancel() }
}
_ = try? await pump.value
watchdog.cancel()
stateWatch.cancel()

say("\nideas captured: \(await collected.ideas)")
await session.end()
say("done.")
exit(0)
