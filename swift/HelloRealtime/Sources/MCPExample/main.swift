import CosmoRealtime
import Foundation

// A headless live proof of the Agent + MCP loop: connect a local stdio MCP
// server, open a real session through the Agent, send a user turn as text,
// and watch the model call one of the server's `mcp__<server>__<tool>` tools
// and act on the result.
//
//   COSMO_API_KEY=...  COSMO_BASE_URL=https://app.askcosmo.ai \
//     swift run MCPExample
//
// By default it loads ./mcp.json (the bundled `everything` server) and asks
// the model to use its `echo` tool. Optional overrides:
//   COSMO_MCP_CONFIG   path to the .mcp.json    (default: mcp.json)
//   COSMO_MCP_PROMPT   the opening user turn

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
let configPath = ProcessInfo.processInfo.environment["COSMO_MCP_CONFIG"] ?? "mcp.json"
let prompt = ProcessInfo.processInfo.environment["COSMO_MCP_PROMPT"]
    ?? "Please use your echo tool to repeat the phrase 'hello from mcp' back to me, then tell me what it returned."

let configURL = URL(fileURLWithPath: configPath)
guard FileManager.default.fileExists(atPath: configURL.path) else {
    fputs("error: no MCP config at \(configURL.path) — run from Examples/HelloRealtime or set COSMO_MCP_CONFIG\n", stderr)
    exit(1)
}

print("== loading MCP servers from \(configURL.path) ==")
let registry = try McpRegistry.fromConfigFile(configURL)
let agent = try Agent(mcp: registry)

let options = RealtimeSession.Options(apiKey: apiKey, baseURL: baseURL)
let config = SessionConfig(
    instructions: "You are a concise assistant. When a tool can answer, call it.")

print("connecting to \(baseURL.absoluteString) (spawning MCP subprocess)…")
let session = try await agent.start(options, config: config, micMuted: true)

var sawMcpCall = false
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
                let isMcp = call.name.hasPrefix("mcp__")
                if isMcp { sawMcpCall = true }
                print("● TOOL CALL: \(call.name)" + (isMcp ? "   ⟵ MCP TOOL CALLED ✅" : ""))
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
try await session.session.send(text: prompt, audioResponse: false)

try await Task.sleep(nanoseconds: 15_000_000_000)
print("\nending session…")
await session.end()
pump.cancel()
print(sawMcpCall ? "done — MCP tool was exercised ✅" : "done — no MCP tool call observed ⚠️")
