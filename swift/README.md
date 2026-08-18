# CosmoAI Swift SDK

Native async/await Swift client for the Cosmo Realtime API.

> **Beta.** CosmoAI is pre-1.0: minor releases (`0.x` → `0.y`) may include
> breaking API changes — check the
> [changelog](https://platform.askcosmo.ai/docs/meta/changelog) when you
> update. Cosmo cuts 1.0 once the wire protocol and the public session API
> have stabilized.

> New to the SDK? Start with the [documentation](https://platform.askcosmo.ai/docs)
> — getting started, the credential model, and the expected session lifecycle.

Source of truth and issue tracker:
[socratic-ai/cosmo-ai](https://github.com/socratic-ai/cosmo-ai) (the `swift/`
directory). The
[cosmo-swift-sdk](https://github.com/socratic-ai/cosmo-swift-sdk) repository is
the Swift Package Manager distribution of the same code — re-rooted and tagged,
because SwiftPM consumes a repository whose root is the package. Install from
it; file issues on cosmo-ai.

## Requirements

- macOS 13+ or iOS 16+
- Swift 5.9+

## Installation

```swift
dependencies: [
    .package(url: "https://github.com/socratic-ai/cosmo-swift-sdk", from: "0.6.0"),
],
targets: [
    .target(
        name: "YourTarget",
        dependencies: [
            // The package resolves as `CosmoAI`; the module you import
            // is `CosmoRealtime`.
            .product(name: "CosmoRealtime", package: "cosmo-swift-sdk"),
        ]
    ),
]
```

Or add via Xcode: **File → Add Package Dependencies…**, paste
`https://github.com/socratic-ai/cosmo-swift-sdk`, and keep the default
**Up to Next Major Version**.

The `from:` range accepts every release below 1.0, and the
[documentation](https://platform.askcosmo.ai/docs) describes the latest
release — if a documented API is missing in your build, run
`swift package update` first.

## Teach your agent

One [Agent Skill](https://agentskills.io) covers the whole Cosmo SDK
family (TypeScript, Python, Swift): the current SDK API, the credential
and login rules, and the production token flow. It teaches coding agents
(Claude Code, Cursor, Codex CLI, Gemini CLI, …) — install it once per
machine or project:

```bash
npx skills add socratic-ai/cosmo-ai
```

Agents can also read the docs directly:
https://platform.askcosmo.ai/docs (`/llms.txt`, `/llms-full.txt`, and an
MCP endpoint at `/docs/api/mcp`).

## Quickstart

One call starts a session; everything the server says arrives on a single
typed event stream.

```swift
import CosmoRealtime

struct WeatherArgs: Decodable, Sendable {
    let city: String
}

let session = try await RealtimeSession.start(
    .init(apiKey: "cosmo_your_api_key"),
    config: SessionConfig(
        instructions: "You are a terse assistant.",
        tools: [
            // Client tool: the agent runs it over the transport and the
            // returned object is reported back as the result.
            try SessionConfig.Tool.define(
                name: "get_weather",
                description: "Current weather for a city.",
                input: .object(
                    properties: ["city": .string(description: "City name")],
                    required: ["city"]
                )
            ) { (args: WeatherArgs) in
                ["temp": .double(21.5), "city": .string(args.city)]
            },
            .webSearch,
        ],
        greeting: "Hi — what can I do for you?"
    )
)

for try await event in session.events {
    switch event {
    case .ready(let ready):
        print("live — session:", ready.sessionId)
        try await session.send(text: "Hello!")
    case .transcript(let delta):
        print(delta.text)
    case .toolInvocation(let invocation):
        // Observability: the agent invoked a client tool. Execution +
        // reply happen via the tool's handler over RPC — nothing to send
        // here.
        print("tool invoked:", invocation.name)
    case .sessionEnded(let ended):
        print("session over:", ended.reason ?? "")
    case .unknown(let rawType, _):
        print("unrecognized event:", rawType ?? "<not JSON>")  // never terminal
    default:
        break
    }
}
```

The microphone is published during `start(...)` unless you pass
`micMuted: true`. Nothing is captured or sent until the first
`setMuted(false)` — do that for a push-to-talk UX, and to be sure a session
your UI presents as muted never streams audio during the connect window.

Microphone permission depends on how you run the binary. A bare `swift run`
executable has no bundle, so it has no `NSMicrophoneUsageDescription` of its
own and inherits the *host terminal's* microphone grant — fine for a
prototype, and confusing when the terminal has no grant. A shipped `.app`
needs its own purpose string. See
[Packaging a macOS app](https://platform.askcosmo.ai/docs/guides/packaging-macos).

## API

### `RealtimeSession.Options`

Client-level settings; pass once per `start`.

| Property | Type | Default |
|---|---|---|
| `credential` | `Credential` | required |
| `baseURL` | `URL` | read-only; `COSMO_BASE_URL`, else `https://platform.askcosmo.ai` |
| `connectTimeout` | `TimeInterval` | `30` |
| `requestTimeout` | `TimeInterval` | `45` |
| `verifyTLS` | `VerifyTLS` | `.auto` |

`Credential` has three forms, and which one you use is a deployment decision:

```swift
// Workspace-scoped key. Server-side only — it opens sessions AND mints
// end-user tokens (minting ships in the opt-in CosmoRealtimeMint product:
// `import CosmoRealtimeMint`). Never embed it in a distributed app.
RealtimeSession.Options(apiKey: "cosmo_…")

// A minted per-user JWT, scoped to one external user. Safe to ship in a
// device or browser: it opens sessions but cannot mint.
RealtimeSession.Options(token: jwt)

// A TokenSource: the SDK fetches the JWT from your minting endpoint,
// caches it, and re-fetches as expiry nears — no refresh code in the app.
RealtimeSession.Options(tokenSource: try .endpoint(
    URL(string: "https://your-backend.example.com/token")!,
    headers: ["Authorization": "Bearer \(appSession)"]
))

// Zero-argument: resolves an API key itself — COSMO_API_KEY, else the
// `cosmo login` credentials file (~/.cosmo/credentials, profile from
// COSMO_PROFILE; the CLI installs with `pipx install cosmo-cli`),
// adopting the backend the stored key was issued for.
// Throws CredentialsError when nothing usable resolves.
try RealtimeSession.Options()
```

`baseURL` is not an argument. It resolves from `COSMO_BASE_URL` — the same
variable the Python and TypeScript SDKs read — falling back to
`https://platform.askcosmo.ai`, and is exposed read-only so you can log which
backend a session will use. Set it explicitly if your key's workspace does not
live on `platform.askcosmo.ai`: Cosmo also serves `https://assistant.askcosmo.ai`,
a separate member-facing surface with its own workspaces, and a key minted on
one surface fails as a `401` on the other.

An app that picks its backend at launch (a GUI app has no inherited
environment) publishes the choice with `setenv` before starting a session.
One process, one backend.

`verifyTLS` defaults to `.auto`, which skips verification only for loopback
hosts so a self-signed local-dev backend works; remote hosts are always
verified.

### `SessionConfig`

Per-session configuration. Every field is optional — unset fields stay off
the wire and the server applies neutral defaults.

| Field | Meaning |
|---|---|
| `agentName` | Run a workspace catalog agent by handle; the stored config runs verbatim. Only `agentInputs`, `tools`, and `voice` may accompany it |
| `agentInputs` | Template placeholder values for the referenced agent. Valid only alongside `agentName` |
| `model` | Provider/model selection |
| `modelOptions` | Provider-scoped model knobs, discriminated on provider (`.gemini`, `.openai`, `.ultravox`, `.personaplex`) so an illegal pairing is unrepresentable |
| `voice` | How the agent sounds: `.init(name:speakingStyle:)` — prebuilt voice id plus delivery guidance |
| `audio` | The audio pipeline: `.init(output:noiseCancellation:ambience:)` — ambience present = enabled |
| `instructions` | System instructions |
| `tools` | Client-executed specs this app fulfills, and typed zero-config server-tool opt-ins (`.webSearch`, `.examineImage`, `.detectObjects`, `.pointAtObject`) |
| `interruptionSensitivity` | How readily the user's speech interrupts the agent (`.default` / `.low` / `.high`) |
| `greeting` | Opening line the assistant speaks first, voiced server-side as soon as the model session opens — before the client even receives `ready` |
| `resumeSessionId` | Resume a prior session (rides under the experimental knobs) |
| `maxSessionSeconds` | Requested wall-clock cap. The server takes the minimum of this and its own limit, and echoes the effective value on `ready` |
| `storeRecording` | Persist this run's recording artifacts server-side |
| `hooks` | Lifecycle observers and policy gates — see [Hooks](#hooks) |

### Tools

`SessionConfig.Tool.define` is the tool API to reach for: you write a
`ToolSchema` and a `Decodable` args struct, and the SDK validates the
declaration at construction and decodes the arguments for you.

```swift
struct BookArgs: Decodable, Sendable {
    let table: String
    let partySize: Int
}

let bookTable = try SessionConfig.Tool.define(
    name: "book_table",
    description: "Reserve a table.",
    input: .object(
        properties: [
            "table": .string(description: "Table id"),
            "partySize": .integer(description: "Number of guests"),
        ],
        required: ["table", "partySize"]
    )
) { (args: BookArgs) in
    ["confirmation": .string(reserve(args.table, args.partySize))]
}
```

`input` and `Args` are written separately and nothing forces them to agree —
pin the pair with `ToolSchemaConsistencyCheck` in your unit tests. A schema
`default` is model guidance only: an omitted field decodes as `nil`, so fall
back in code (`args.unit ?? .c`).

`defineBackground` is the same declaration and decoding for a long-running
tool: the handler drives a `ClientToolJob` (`ack` / `complete` / `fail`) so the
agent can keep talking while the work runs.

`.client(name:description:parameters:handler:)` is the untyped escape hatch —
a hand-built JSON schema and a raw `[String: JSONValue]` handler. Use it only
when the schema is computed at runtime. A spec without a handler is still
declared to the agent but only surfaces its invocation as a `.toolInvocation`
observability event.

Handlers are local-only — never serialized, never on the wire.

### Event stream

`session.events` is a single-consumer `AsyncThrowingStream` of
`RealtimeSession.Event` — one case per server event (`ready`, `transcript`,
`modelText`, `turnComplete`, speech/LLM/TTS phases, the tool lifecycle,
`reconnecting`, `error`, `pong`) plus:

- `.unknown(rawType:payload:)` — any unrecognized or undecodable frame.
  Forward compatibility is explicit: decode failure is **never** terminal.
- `.sessionEnded(_)` — always the final element; the stream finishes after
  it. The transport close is the terminal signal, so this sentinel is
  synthesized locally on `end()`, teardown, or a transport drop. The server
  publishes a best-effort `session-ended` wire frame before a deliberate
  teardown; the SDK latches its reason onto the sentinel rather than
  surfacing the frame mid-stream. Start failures throw from `start(...)`
  instead (for example, `RealtimeSessionError.versionMismatch`).

Oversized server messages arrive chunked (`server-envelope-chunk`) and are
reassembled transparently before they surface as events.

`session.states` separately reports the transport lifecycle (`idle`,
`connecting`, `connected`, `reconnecting`/`reconnected`,
`disconnected(reason:)`).

#### Transcripts append, then replace

`.transcript` carries two different things depending on `isFinal`, and
rendering them the same way duplicates every turn:

- **`isFinal == false`** — `text` is the **new fragment since the previous
  event** for that role's turn. Append it.
- **`isFinal == true`** — `text` is the **cumulative full transcript** for the
  turn. Replace whatever you accumulated.

```swift
var current = ""
for try await event in session.events {
    guard case .transcript(let delta) = event else { continue }
    current = delta.isFinal ? delta.text : current + delta.text
    render(current)
}
```

`isFinal == true` means "this turn's transcription is complete", not "the
assistant turn is over" — audio can still be playing out. `.turnComplete`
signals the turn boundary.

That reduction is correct for the common path. Two cases need more:

- **An empty final closes the turn.** It means an empty turn, not "unchanged" —
  skip it and the turn's bubble dangles into the next one.
- **On a text-only session** (`audio: .init(output: false)`) a user final that
  arrives after the endpointer already committed an utterance carries only the
  remainder, so replacing on it drops the committed prefix.

### Sends

```swift
try await session.send(text: "Hello")
try await session.setMuted(true)
try await session.ping()
await session.end()             // graceful: wire end frame, then teardown
await session.waitUntilEnded()  // returns once the session is over
```

Client tools aren't sent here — declare a handler on the tool spec and the
SDK runs it over the transport when the agent invokes it.

For audio the SDK can't capture itself — a synthetic generator, file replay,
or a host with no usable microphone — publish it yourself:

```swift
try await session.startAudioStream()
audio.push(pcmBuffer)               // from your render callback
await session.stopAudioStream()
```

While the stream is live the device microphone is silenced, so the agent hears
exactly the buffers you push; removing it restores the microphone.

`waitUntilEnded()` returns once the session has ended for any reason (`end()`,
a server-side stop, or a transport drop). It's the supported way to keep a
CLI alive for the length of a call; it doesn't consume `events`, so you can
drain the stream from another task and await this one on the main path.

### Readiness vs liveness

`.ready` is the authoritative signal and the only one that carries the session
id, the rejected-tool list, and the effective duration cap. Gate on it.

`await session.waitUntilAgentLive()` is a separate, weaker signal: it returns
once the agent participant publishes a track, which is LiveKit's transport-level
proof that somebody is on the other end. It carries no session metadata. Use it
to drive a spinner without gating that spinner on a data frame, and as a
backstop if you want to distinguish "the agent never showed up" from "the agent
is here but I have no metadata yet". It also returns if the session ends first,
so it never outlives the session.

## Hooks

Attach lifecycle observers and policy gates to any session by putting `Hook`
values on `SessionConfig.hooks`. Four events fire: **SessionStart** (before the
wire frame is sent), **PreToolUse** (before a client tool runs), **PostToolUse**
(after), and **SessionEnd** (once, on any exit path). SessionStart and
PreToolUse carry honored overrides: return `SessionStartResult(additionalContext:)`
to inject additional instructions, or `PreToolUseResult(permission: .deny, reason:)`
to block a client tool before it executes. A throwing hook is logged and
skipped; sibling hooks still run. Hooks are local-only — closures are never
serialized or sent on the wire.

```swift
var config = SessionConfig()
config.hooks = [
    sessionStart { _ in
        SessionStartResult(additionalContext: "The user is on the premium plan.")
    },
    // Block any client tool whose name matches the "delete_*" glob.
    try preToolUse(matcher: "delete_*") { _ in
        PreToolUseResult(permission: .deny, reason: "destructive tools are disabled")
    },
    try postToolUse { ctx in print(ctx.toolName, ctx.outcome) },
    sessionEnd { ctx in print("session stopped:", ctx.reason ?? "unknown") },
]

let session = try await RealtimeSession.start(options, config: config)
```

`preToolUse` and `postToolUse` take an optional glob matcher on the tool name
and **throw** — a malformed matcher is rejected there, not at session start.
`sessionStart` and `sessionEnd` take no matcher and don't throw.

A fired server-hook silence timeout (a `Hook.server(SilenceTimeout(...))` entry
in the same list) reaches you as a `.userSpeechTimeout` event on the session's
event stream, not as a hook — the server executes it even if this process dies
mid-call.

### Live e2e (`HooksExample`)

`HelloRealtime/Sources/HooksExample` in the [examples repo](https://github.com/socratic-ai/cosmo-ai/tree/main/examples/swift) is a self-contained runnable
harness that exercises all four hooks in one headless session: SessionStart
(inject caller context), PreToolUse/deny (block `delete_account` before it
runs), PreToolUse/rewrite (force `account=primary` on `get_account_balance`),
PostToolUse (observe outcome), and SessionEnd (observe exit reason).

```bash
git clone https://github.com/socratic-ai/cosmo-ai && cd cosmo-ai/examples/swift/HelloRealtime
COSMO_API_KEY=cosmo_… swift run HooksExample
```

Each `◆ HOOK` line in the output proves the corresponding hook fired. The
`▶ handler delete_account` line must not appear — the PreToolUse/deny hook
suppresses it before the handler is invoked.

## Skills

Attach **Agent Skills** (the `SKILL.md` standard) to the model through the
`RealtimeAgent` layer. Parsed skills become a single resident `cosmo_sdk_load_skill`
tool plus a hot-set menu appended to `SessionConfig.instructions`; the model
calls `cosmo_sdk_load_skill(name)` when the conversation reaches a skill's path
and receives the body as private, never-spoken instructions for the rest of the
call.

```swift
let skills = [try parseSkillMd(refundsMarkdown, defaultName: "refunds")]
let agent = try RealtimeAgent(skills: skills)
let session = try await agent.start(
    RealtimeSession.Options(token: jwt),
    config: SessionConfig(instructions: "You are a terse support agent."))
// the menu is now resident; the model can call cosmo_sdk_load_skill("refunds")
await session.end()
```

`RealtimeAgent.init` **throws**: duplicate skill names are rejected when the agent is
built, not mid-call. `RealtimeAgent` composes skills, MCP, and caller tools together —
all land in `SessionConfig.tools`. Every attached skill rides resident as
`name` + `description`; only the body is deferred to `cosmo_sdk_load_skill`. Unknown
`SKILL.md` frontmatter keys (`tier`, `allowed-tools`, `license`, …) are
accepted and ignored, so documents authored for other harnesses stay valid.

`HelloRealtime/Sources/SkillsExample` in the examples repo is a runnable version.

## MCP servers (local stdio)

Expose a local [MCP](https://modelcontextprotocol.io) server's tools to the
realtime model through the `RealtimeAgent` layer. Declare servers in a Claude-Code
`.mcp.json`; the SDK spawns each, lists its tools, and proxies calls — tools are
namespaced `mcp__<server>__<tool>` and ride in `SessionConfig.tools` as ordinary
client tools.

```swift
let registry = try McpRegistry.fromConfigFile(url)
let agent = try RealtimeAgent(mcp: registry)
let session = try await agent.start(
    RealtimeSession.Options(token: jwt))
// drive session.events … ; then:
await session.end()
```

v1 supports **stdio** servers (macOS — subprocess); remote (`url`) entries in
`.mcp.json` are skipped with a warning. A `StdioServer` runs an arbitrary local
command — trust your config. No third-party dependency is added.

`HelloRealtime/Sources/MCPExample` in the examples repo is a runnable version.

## Authentication

Workspace-scoped API key with `realtime:use` scope, passed as:

```
Authorization: Bearer cosmo_<key>
```

The key is injected automatically via `RealtimeSession.Options(apiKey:)`. For
anything you distribute, mint a per-user token instead and construct with
`RealtimeSession.Options(token:)`.

`RealtimeClient(options).verify()` checks the credential without starting a
session — free, no room, no agent. It returns the workspace it's bound to, its
scopes, whether it carries `realtime:use` (`canStartSessions`), and whether the
deployment has the default voice stack configured (`realtimeVoiceAvailable`).
`workspace` is nil
for a minted token — it runs on an end user's device, which isn't told whose
workspace it belongs to. Only a credential the server rejects throws
(`VerifyError`); an under-scoped one comes back as a result.

`session.usage()` fetches the session's usage summary over REST — duration,
talk time, and token counts in provider-reported units — during the session or
after it ends. `usageStatus` reports whether the detailed summary is there:
`.pending` while it may still land, `.recorded` once the numbers are final,
`.unavailable` when none was written and none will be. `tokens` is nil when
the provider doesn't report token usage. Throws `UsageError`.
`RealtimeClient(options).sessionUsage(sessionId:)` is the client-level form.

## Architecture

```
RealtimeSession (actor)                  — public stream API
 ├── events / states                     — AsyncThrowingStream / AsyncStream
 ├── EnvelopeReassembler (actor)         — server-envelope-chunk reassembly
 └── SessionTransport                    — protocol-agnostic transport seam
      └── LiveKitSessionTransport        — production implementation
           ├── CosmoRealtimeAPI.Client   — POST /api/v1/external/realtime/session/start
           └── Room (LiveKit)            — WebRTC audio + data channel
```

Generated wire types live in the internal `CosmoRealtimeAPI` module
(regenerated on every build from the OpenAPI spec at
`Sources/CosmoRealtimeAPI/openapi.json`) and are re-exposed under clean names
(`RealtimeSession.Ready`, `RealtimeSession.TranscriptDelta`, …) so consumers
only ever `import CosmoRealtime`.

## Example

See [`HelloRealtime/`](https://github.com/socratic-ai/cosmo-ai/tree/main/examples/swift/HelloRealtime) in the examples repo for a runnable macOS
command-line program that connects, declares a typed client tool, listens for
transcripts, sends a text message, and disconnects — no audio required.

```bash
git clone https://github.com/socratic-ai/cosmo-ai && cd cosmo-ai/examples/swift/HelloRealtime
COSMO_API_KEY=cosmo_… swift run
```

`BackgroundToolExample`, `HooksExample`, `SkillsExample`, and `MCPExample` live
alongside it as `swift run <target>` programs.

[`Cartographer/`](https://github.com/socratic-ai/cosmo-ai/tree/main/examples/swift/Cartographer) is the GUI counterpart: a
SwiftUI macOS app that draws a live mind map from what you say, with client
tools mutating on-screen state and hooks enforcing an app-side limit. Its
`bundle.sh` is also the reference for packaging a SwiftPM-built `.app` that can
actually reach the microphone.

```bash
git clone https://github.com/socratic-ai/cosmo-ai && cd cosmo-ai/examples/swift/Cartographer
COSMO_API_KEY=cosmo_… ./run.sh --demo
```

## Testing

The SDK ships two test targets:

- **`CosmoRealtimeTests`** — unit tests exercising `RealtimeSession` over an
  in-memory fake transport. No network, no LiveKit server. Runs on every
  `swift test`.
- **`CosmoRealtimeE2ETests`** — exercises the full connect / send / receive /
  disconnect cycle against a real `livekit-server` in dev mode. **Skipped
  unless `LIVEKIT_TESTING_URL` is set.**

```bash
swift test                       # only the unit suite — fast, offline
```

To include the E2E suite, start a local `livekit-server` in dev mode and point
the env vars at it:

```bash
LIVEKIT_TESTING_URL=ws://localhost:7880 \
  LIVEKIT_TESTING_API_KEY=devkey \
  LIVEKIT_TESTING_API_SECRET=devsecretdevsecretdevsecretdevse \
  swift test
```

## License

Licensed under the [Apache License, Version 2.0](LICENSE). Copyright 2026
Socratic AI, Inc.

## Export Control

This distribution includes cryptographic software. The country in which you
currently reside may have restrictions on the import, possession, use, and/or
re-export to another country of encryption software. Before using any encryption
software, check your country's laws, regulations, and policies concerning the
import, possession, use, and re-export of encryption software.

The Cosmo SDK is published by Socratic AI, Inc. as publicly available source
code. It uses standard TLS/HTTPS and WebRTC (DTLS-SRTP) for transport security
and does not implement proprietary cryptographic algorithms. By downloading or
using this software you represent that you are not located in, or a national or
resident of, any country subject to U.S. embargo or comprehensive sanctions, and
that you are not on any U.S. government restricted-party list.
