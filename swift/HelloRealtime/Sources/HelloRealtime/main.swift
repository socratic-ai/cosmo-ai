import CosmoRealtime
import Foundation

let apiKey = ProcessInfo.processInfo.environment["COSMO_API_KEY"] ?? {
    fputs("error: set COSMO_API_KEY environment variable\n", stderr)
    exit(1)
}()

let baseURLString = ProcessInfo.processInfo.environment["COSMO_BASE_URL"] ?? {
    fputs("error: set COSMO_BASE_URL environment variable (e.g. https://api.example.com)\n", stderr)
    exit(1)
}()

guard let baseURL = URL(string: baseURLString) else {
    fputs("error: COSMO_BASE_URL is not a valid URL: \(baseURLString)\n", stderr)
    exit(1)
}

struct WeatherArgs: Decodable, Sendable {
    let city: String
    let unit: Unit?
    enum Unit: String, Decodable, Sendable { case c, f }
}

let getWeather = try SessionConfig.Tool.define(
    name: "get_weather",
    description: "Current weather for a city",
    input: .object(
        properties: [
            "city": .string(description: "City name"),
            "unit": .enum(["c", "f"]),
        ],
        required: ["city"]
    )
) { (args: WeatherArgs) in
    let unit = args.unit ?? .c
    print("[tool] get_weather city=\(args.city) unit=\(unit.rawValue)")
    return ["temp": .double(unit == .c ? 21.5 : 70.7), "unit": .string(unit.rawValue)]
}

// One call starts the session: REST session-start + LiveKit join, publishing the
// mic during the join. The external protocol scopes the project from the API key
// server-side, so there is no project_id to pass here.
print("Connecting…")
let session = try await RealtimeSession.start(
    .init(apiKey: apiKey, baseURL: baseURL),
    config: SessionConfig(tools: [getWeather])
)

// Consumption is a single typed event stream. Drain it on a task; `.sessionEnded`
// is the final element and finishes the stream. No listeners to register up
// front — the stream buffers from session start, so nothing is missed.
let events = Task {
    do {
        for try await event in session.events {
            switch event {
            case .ready(let ready):
                print("Session ready — id: \(ready.sessionId)")
                print("Speak into your microphone. Press Enter to end.")
            case .transcript(let delta):
                let role = delta.role == .user ? "user" : "assistant"
                let marker = delta.isFinal ? " »" : "…"
                print("[\(role)]\(marker) \(delta.text)")
            case .error(let err):
                fputs("Server error (\(err.code.rawValue)): \(err.message)\n", stderr)
            case .sessionEnded(let ended):
                print("Session ended: \(ended.reason ?? "")")
            default:
                break
            }
        }
    } catch {
        fputs("event stream error: \(error)\n", stderr)
    }
}

print("Microphone live.")

// Block until the user presses Enter, then tear down gracefully.
_ = readLine()

print("Ending…")
await session.end()
events.cancel()

print("Done.")
