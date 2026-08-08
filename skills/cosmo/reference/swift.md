# Swift (`CosmoRealtime` via Swift Package Manager)

Read [core.md](core.md) first. Full API reference:
https://platform.askcosmo.ai/docs. This file is the Swift gotchas.

## Current shape

Package `https://github.com/socratic-ai/cosmo-swift-sdk`, product
`CosmoRealtime`, pinned `.upToNextMinor` (pre-1.0). macOS 13+ / iOS 16+,
Swift 5.9+. That is the SDK's floor; an individual example may declare a
higher one of its own (Cartographer targets macOS 14).

```swift
// Zero-argument Options resolves COSMO_API_KEY, else the `cosmo login`
// credentials file; throws CredentialsError when nothing usable resolves.
let session = try await RealtimeSession.start(
    try RealtimeSession.Options(),
    config: SessionConfig(
        voice: .init(name: "Upbeat"),
        instructions: "You are terse."
    )
)

for try await event in session.events {
    switch event {
    case .transcript(let d): print(d.text)
    case .sessionEnded(let e): print(e.reason ?? "")
    default: break
    }
}
```

## Gotchas

- **The module is `CosmoRealtime`; the package resolves as `CosmoAI`.**
  There is no client object: `RealtimeSession.start(_:config:)` takes
  `Options` + `SessionConfig`; `session.events` is the typed stream.
- **`baseURL` is not an `Options` argument.** It resolves from
  `COSMO_BASE_URL` and is exposed read-only. A GUI app has no inherited
  environment — publish the choice with `setenv` before starting a
  session. One process, one backend.
- **Minting is deliberately absent from `CosmoRealtime`** — a shipped app
  can't mint. Server-side Swift that mints imports the opt-in
  `CosmoRealtimeMint` product.
- **Tools**: `SessionConfig.Tool.define(...)` with a trailing handler
  closure; the returned object is the tool result.
- **Slow tools**: `SessionConfig.Tool.defineBackground(...)`. The closure
  takes `(args, job: ClientToolJob)` and returns `Void` — `await
  job.ack("on it")` releases the reply so the agent keeps talking, then
  `try await job.complete(result:summary:)` or `try await
  job.fail(error:)` delivers the outcome whenever the work lands.
  Returning without acking is an error, not an inline result; a throw
  after acking is reported through the job. `ClientToolJob` is the
  per-invocation handle, not a kind of tool.
- **`verifyTLS` defaults to `.auto`**: certificate verification is
  skipped only for loopback hosts, so a self-signed-https local backend
  works. Plain `http://` is a separate rule — `COSMO_BASE_URL` accepts it
  for localhost only.
- **Keys are per-surface**: a `platform.askcosmo.ai` key fails as `401`
  against `assistant.askcosmo.ai`. Set `COSMO_BASE_URL` to the backend
  the key was issued for — or use the stored `cosmo login` credential,
  which carries its backend with it.

## Runnable examples

`HelloRealtime` (minimal macOS voice session, plus background-tool / MCP /
hooks / skills variants) and `Cartographer` (a GUI macOS agent app) in the
[cosmo-ai examples](https://github.com/socratic-ai/cosmo-ai).
