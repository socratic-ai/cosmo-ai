import CosmoRealtime
import Foundation

// Two tools that do the same slow work, declared side by side, so the
// difference between them is visible in the transcript.
//
//   check_status   — a regular client tool. The reply is its return value, so
//                    the conversation waits for it.
//   export_report  — a background client tool. Its handler acks first, which
//                    releases the reply immediately, and delivers the result
//                    when the work finishes.
//
// Run:
//   COSMO_API_KEY=... swift run BackgroundToolExample
//
// Watch the ⏱ lines. `export_report` prints its ack and returns to the model
// in milliseconds; the ✓ terminal line lands seconds later, and the agent is
// free to keep talking in between.

let exportSeconds = ProcessInfo.processInfo.environment["COSMO_EXPORT_SECONDS"]
    .flatMap(Double.init) ?? 12

let started = Date()
func stamp() -> String { String(format: "%+6.2fs", Date().timeIntervalSince(started)) }

// MARK: - Blocking client tool

struct StatusArgs: Decodable, Sendable {
    let service: String
}

let checkStatus = try SessionConfig.Tool.define(
    name: "check_status",
    description: "Current status of a named service. Answers immediately.",
    input: .object(
        properties: ["service": .string(description: "Service name")],
        required: ["service"]
    )
) { (args: StatusArgs) in
    print("⏱ \(stamp()) [check_status] handler ran service=\(args.service)")
    return ["status": .string("healthy"), "service": .string(args.service)]
}

// MARK: - Background client tool

struct ExportArgs: Decodable, Sendable {
    let quarter: String
}

// `defineBackground` gives the handler a second argument, a `ClientToolJob`.
// The job is the handle for one invocation: `ack` releases the reply, and
// `complete` / `fail` delivers the outcome once the work is done.
let exportReport = try SessionConfig.Tool.defineBackground(
    name: "export_report",
    description: """
        Export the quarterly report. Takes a while, so it returns immediately \
        and the finished export arrives later.
        """,
    input: .object(
        properties: ["quarter": .string(description: "Quarter to export, e.g. Q3")],
        required: ["quarter"]
    )
) { (args: ExportArgs, job: ClientToolJob) in
    // Ack first. Everything after this line runs while the agent talks.
    await job.ack("Starting the \(args.quarter) export. I'll say when it's ready.")
    print("⏱ \(stamp()) [export_report] acked — reply released, work continues")

    try await Task.sleep(nanoseconds: UInt64(exportSeconds * 1_000_000_000))

    let url = "https://example.com/reports/\(args.quarter.lowercased()).pdf"
    try await job.complete(
        result: ["url": .string(url)],
        summary: "The \(args.quarter) report is ready."
    )
    print("⏱ \(stamp()) [export_report] ✓ completed — result delivered to the agent")
}

// A handler that throws before acking answers the call inline as an error. One
// that throws after acking is reported through the job, so the model hears
// about the failure whenever it happens. To report a failure yourself, call
// `try await job.fail(error: "…")` in place of `complete`.

// MARK: - Session

actor ReadyFlag {
    private var ready = false
    func set() { ready = true }
    func get() -> Bool { ready }
}
let readyFlag = ReadyFlag()

let options = try RealtimeSession.Options()
let config = SessionConfig(
    instructions: """
        You are a terse reporting assistant. When the user asks for an export, \
        call export_report, then tell them it is running and stay available. \
        Announce the finished export as soon as its result reaches you.
        """,
    tools: [checkStatus, exportReport]
)

print("Connecting to \(options.baseURL.absoluteString)…")
let session = try await RealtimeSession.start(options, config: config, micMuted: true)

let pump = Task {
    do {
        for try await event in session.events {
            switch event {
            case .ready:
                print("⏱ \(stamp()) ● session live")
                await readyFlag.set()
            case .transcript(let t):
                print("⏱ \(stamp()) [\(t.role)] \(t.text)" + (t.isFinal ? "" : " …"))
            case .toolCall(let call):
                print("⏱ \(stamp()) ● tool call: \(call.name)")
            case .toolResult(let result):
                print("⏱ \(stamp()) ● tool result: ok=\(result.ok)"
                    + (result.summary.map { " — \($0)" } ?? ""))
            case .error(let err):
                print("⏱ \(stamp()) ● error \(err.code.rawValue): \(err.message)")
            case .sessionEnded(let ended):
                print("⏱ \(stamp()) ● session ended: \(ended.reason ?? "")")
                return
            default:
                break
            }
        }
    } catch {
        fputs("event stream error: \(error)\n", stderr)
    }
}

for _ in 0..<120 {
    if await readyFlag.get() { break }
    try await Task.sleep(nanoseconds: 500_000_000)
}

print("\n> user: Is the billing service up?\n")
try await session.send(text: "Is the billing service up?")
try await Task.sleep(nanoseconds: 8_000_000_000)

print("\n> user: Great. Export the Q3 report for me.\n")
try await session.send(text: "Great. Export the Q3 report for me.")

// A turn while the export is still running: the agent answers it, which is the
// whole point of acking rather than blocking.
try await Task.sleep(nanoseconds: 5_000_000_000)
print("\n> user: While that runs, what else can you do?\n")
try await session.send(text: "While that runs, what else can you do?")

// Long enough for the export to finish and be announced.
try await Task.sleep(nanoseconds: UInt64((exportSeconds + 12) * 1_000_000_000))

print("\nEnding…")
await session.end()
pump.cancel()
print("Done.")
