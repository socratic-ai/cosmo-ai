---
name: cosmo
description: >-
  Teaches the current Cosmo Realtime SDK API across TypeScript (`cosmo-ai`
  on npm), Python (`cosmo-ai-sdk` on PyPI), and Swift (`cosmo-swift-sdk` via
  Swift Package Manager, imported as `CosmoRealtime`): login and credentials,
  voice/multimodal agents, realtime sessions, client tools, hooks, agent
  skills, telephony, minting end-user tokens, and deploying/sharing apps
  built on the SDK. Use when writing, reviewing, or debugging code that uses
  any of these SDKs — read reference/core.md before writing any realtime
  code.
---

# Cosmo Realtime SDK

One wire protocol, three SDKs, one shape: a **client** (credential +
endpoint) builds an immutable **agent** (persona: instructions, voice,
tools), and `agent.start()` runs a **session** (a stream of typed events).

## Step 1: get a credential (start here, all three SDKs)

On a developer machine, the fastest path is the Cosmo CLI:

```bash
curl -fsSL https://platform.askcosmo.ai/docs/install.sh | sh
cosmo init     # browser sign-in; stores an API key in ~/.cosmo/credentials
```

`uv tool install cosmo-cli` and `pipx install cosmo-cli` install the CLI
directly. `cosmo login` is the sign-in on its own, and is what re-auth and
a workspace switch call.

After sign-in, zero-argument construction works out of the box — the
SDK resolves `COSMO_API_KEY` from the environment, else the stored
credentials file, and adopts the backend the stored key was issued for:

```python
client = RealtimeClient()                       # Python
```

```ts
const client = new RealtimeClient({});         // TypeScript (Node)
```

```swift
let client = try RealtimeClient()              // Swift
```

Two rules that must always hold:

- An API key (`cosmo_…`) lives on servers and laptops only. Anything
  shipped to an end user (browser, phone, binary) gets a short-lived
  minted JWT instead — pass `TokenSource.endpoint(url)` as the `token`
  credential and the SDK fetches and refreshes it itself. Never put an API
  key behind a `VITE_` / `NEXT_PUBLIC_` variable.
- Minting is the productionization step, for when an app ships to end
  users. For local dev and server-side apps, the logged-in key alone is
  the whole story — don't scaffold token minting for a prototype.

## Step 2: read the reference for the language being written

Always: [reference/core.md](reference/core.md) — the full credential
rules and the cross-SDK gotchas. Then the language layer:

- **TypeScript**: [reference/typescript.md](reference/typescript.md) —
  React bindings, the `cosmo-ai/server` entry, the `session.on` callback
  layer, Zod tools
- **Python**: [reference/python.md](reference/python.md) — install and
  platform notes, Pydantic tools
- **Swift**: [reference/swift.md](reference/swift.md) — SwiftPM install,
  zero-argument options, the `CosmoRealtimeMint` module, TLS and backend
  selection

## Workflows

- **Build a voice agent with a tool** (Python):
  [examples/build-a-voice-agent.md](examples/build-a-voice-agent.md)
- **Ship a browser app and share it** (TypeScript — mint route + deploy):
  [examples/share-a-web-app.md](examples/share-a-web-app.md)
- **Production credentials — the token server and the end-user token
  lifecycle** (mint scope, TokenSource, TTL, revocation; all languages):
  [reference/end-user-tokens.md](reference/end-user-tokens.md)

## Start from a runnable example

Complete runnable examples for all three SDKs live in the
[cosmo-ai repository](https://github.com/socratic-ai/cosmo-ai) under
`examples/`: a token-minting server, a browser voice page (Vite + React),
a deployable docs agent, and a video-grounded voice coach (TypeScript); a
minimal session, a terminal voice client, outbound calling, and
hooks/skills/MCP agents (Python); HelloRealtime with MCP/hooks/skills
variants and a GUI agent app (Swift). Derive new apps from the closest
example rather than starting from a blank file.

## More

Full docs, guides, and an MCP endpoint for live API lookup:
https://platform.askcosmo.ai/docs (agents:
`https://platform.askcosmo.ai/docs/llms.txt` and
`https://platform.askcosmo.ai/docs/llms-full.txt` — the paths are under
`/docs`; the site root serves the app, not the agent files).
