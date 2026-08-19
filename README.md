<h1 align="center">Cosmo AI</h1>

<p align="center"><b>Build realtime agents that see, hear, speak — and keep getting better.</b></p>

<p align="center">
  <a href="https://cosmo-ai.dev">cosmo-ai.dev</a> ·
  <a href="https://platform.askcosmo.ai/docs">Documentation</a> ·
  <a href="https://platform.askcosmo.ai/docs/meta/changelog">Changelog</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/cosmo-ai"><img src="https://img.shields.io/npm/v/cosmo-ai" alt="npm" /></a>
  <a href="https://pypi.org/project/cosmo-ai-sdk/"><img src="https://img.shields.io/pypi/v/cosmo-ai-sdk" alt="PyPI" /></a>
  <a href="https://github.com/socratic-ai/cosmo-swift-sdk"><img src="https://img.shields.io/badge/swift-SwiftPM-orange" alt="SwiftPM" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License" /></a>
</p>

Cosmo is one SDK for voice and multimodal agents on every surface —
browser, iOS/macOS, phone lines, and headless servers. You define the
agent's persona, tools, skills, and guardrails; the Cosmo harness handles
the transport, the model inference, and the improvement loop underneath a
stable API.

This repository is the home of the Cosmo SDK family:

- [`typescript/`](typescript/) — [`cosmo-ai`](https://www.npmjs.com/package/cosmo-ai) on npm, for web and React
- [`python/`](python/) — [`cosmo-ai-sdk`](https://pypi.org/project/cosmo-ai-sdk/) on PyPI, asyncio end to end
- [`swift/`](swift/) — `CosmoRealtime` for macOS and iOS, installed via [cosmo-swift-sdk](https://github.com/socratic-ai/cosmo-swift-sdk)
- [`examples/`](examples/) — runnable examples for all three SDKs
- [`skills/`](skills/) — the [Agent Skill](https://agentskills.io) that teaches coding agents this SDK

Issues and contributions for any of them belong here.

## Quickstart

### TypeScript

```bash
npm install cosmo-ai
```

```ts
import { RealtimeClient } from 'cosmo-ai';

const client = new RealtimeClient({ token: '<minted-end-user-token>' });

const agent = client.agent({
  instructions: 'You are a terse assistant.',
  voice: 'Puck',
});

const session = await agent.start();

for await (const event of session) {
  switch (event.type) {
    case 'ready':
      console.log(`ready — session ${event.session_id}`);
      break;
    case 'transcript':
      console.log(`[${event.role}] ${event.text}`);
      break;
    case 'session-ended':
      console.log(`ended: ${event.reason}`);
      break;
  }
}
```

### Python

```bash
pip install cosmo-ai-sdk
```

```python
import asyncio
from cosmo_ai import (
    RealtimeClient,
    ReadyEvent,
    SessionEndedEvent,
    TranscriptDeltaEvent,
    TranscriptRole,
)

async def main() -> None:
    client = RealtimeClient(api_key="cosmo_...")
    agent = client.agent(
        instructions="You are a terse assistant.",
        voice="Puck",
    )
    async with agent.start() as session:
        await session.send_text("Hello!")
        async for event in session:
            match event:
                case ReadyEvent():
                    print(f"ready — session {event.session_id}")
                case TranscriptDeltaEvent(is_final=True):
                    who = "agent" if event.role is TranscriptRole.ASSISTANT else "you"
                    print(f"[{who}] {event.text}")
                case SessionEndedEvent():
                    print(f"ended: {event.reason}")
                    break

asyncio.run(main())
```

### Swift

Add [cosmo-swift-sdk](https://github.com/socratic-ai/cosmo-swift-sdk) as a
Swift Package Manager dependency and import `CosmoRealtime` — see
[`swift/README.md`](swift/README.md) for the full quickstart. Requires
macOS 13+ / iOS 16+ and Swift 5.9+.

Each quickstart continues in its SDK's README and in the
[documentation](https://platform.askcosmo.ai/docs).

## Everything a live agent needs

| Capability | What you get |
| --- | --- |
| **Full-duplex voice** | The agent listens while it speaks — users barge in mid-sentence, and per-provider turn-taking options tune how eagerly it yields. |
| **Camera + screen vision** | Sessions take live camera and screen input; server vision tools (`examine_image`, `detect_objects`, `point_at_object`) inspect frames on demand. |
| **Skills** | Package procedures as modular skills the agent loads per turn — capability scales without inflating the system prompt. |
| **Hook guardrails** | `PreToolUse` / `PostToolUse` seams validate or rewrite tool arguments, scrub sensitive data, and deny calls with a reason. |
| **Client and server tools** | Typed client tools run your handlers (foreground or background); server tools opt in with one line — `web_search`, `end_call`, and the vision tools — zero config. |
| **Audit trail** | Every tool call resolves to a typed outcome — `ok`, `error`, or `denied` — surfaced on the event stream. |
| **Typed events** | A session is a stream of typed events — transcripts, tool calls, usage, lifecycle — discriminated unions in TypeScript, typed classes in Python and Swift. |
| **Telephony** | Dial a phone callee into any session (E.164) and run outbound calls. |
| **Resilient sessions** | Network drops heal in place — sessions resume without losing the run. |
| **Model choice** | OpenAI Realtime, Gemini Live, and Grok Voice behind one API — swap providers with a config field, not an app rewrite. |

The same agent definition runs on every surface: a web page, a native app,
a phone call, or a server process — capabilities toggle in config while the
session API stays the same.

## SDKs

| Language | Source | Install |
| --- | --- | --- |
| TypeScript (web & React) | [`typescript/`](typescript/) | `npm install cosmo-ai` |
| Python | [`python/`](python/) | `pip install cosmo-ai-sdk` |
| Swift (macOS & iOS) | [`swift/`](swift/) | Swift Package Manager, via [cosmo-swift-sdk](https://github.com/socratic-ai/cosmo-swift-sdk) |

Releases are tagged per SDK (`typescript/vX.Y.Z`, `python/vX.Y.Z`); npm and
PyPI carry the released packages. Swift Package Manager needs a repository
whose root is the package, so Swift releases are additionally published to
[cosmo-swift-sdk](https://github.com/socratic-ai/cosmo-swift-sdk) — the same
code as [`swift/`](swift/) here, re-rooted and tagged `X.Y.Z`. Use that
repository URL in Xcode; file issues here.

Documentation, quickstarts, and the changelog:
[platform.askcosmo.ai/docs](https://platform.askcosmo.ai/docs).

## Teach your agent

This repository ships the [Agent Skill](https://agentskills.io) for the
whole SDK family — one skill covering TypeScript, Python, and Swift: the
current API, the credential and login rules, and the production token
flow. Install it into your coding agent (Claude Code, Cursor, Codex CLI,
Gemini CLI, ...) once per machine or project:

```bash
npx skills add socratic-ai/cosmo-ai
```

npm users can instead add [`skills-npm`](https://github.com/antfu/skills-npm)
as a dev dependency: the same skill ships inside the `cosmo-ai` package, and
every `npm install` links it at the installed package's version.

## Examples

Each example depends on the published SDK packages and states what it needs
(credentials, environment) at the top of its README or docstring.

| Example | What it shows |
| --- | --- |
| [`examples/typescript/token-server`](examples/typescript/token-server) | Minting end-user tokens from your backend: a single zero-dependency file that runs on Cloudflare Workers, Vercel, Deno Deploy, AWS Lambda, or plain Node |
| [`examples/typescript/realtime-page`](examples/typescript/realtime-page) | A browser voice session on a plain web page |
| [`examples/typescript/docs-agent`](examples/typescript/docs-agent) | A deployable docs-answering agent |
| [`examples/typescript/squat-coach`](examples/typescript/squat-coach) | A voice coach grounded in video analysis done before the call, with a replay tool |
| [`examples/typescript/garden-doctor`](examples/typescript/garden-doctor) | A phone-browser plant doctor on a live camera: server vision tools locate what you ask about and the agent draws boxes and points over the preview |
| [`examples/typescript/chess-coach`](examples/typescript/chess-coach) | A voice chess coach over a live board: client tools move the pieces while the agent teaches |
| [`examples/typescript/sous-chef`](examples/typescript/sous-chef) | A hands-free phone-browser cooking companion: `web_search` finds any recipe, background-tool timers let the agent speak up on its own, and it checks the pan with `examine_image` |
| [`examples/typescript/model-router`](examples/typescript/model-router) | Routing free-text intent to a provider, tuning, and voice via a plain keyword table |
| [`examples/typescript/party-game-night`](examples/typescript/party-game-night) | An AI game-show host on one TV: generative-UI client tools drive a sandboxed board, a skill carries the game, and hooks enforce the house rules |
| [`examples/python`](examples/python) | Minimal session (`hello_realtime.py`), a terminal voice client (`voice_cli`), outbound calling, and hooks / skills / MCP agents |
| [`examples/swift/HelloRealtime`](examples/swift/HelloRealtime) | Minimal macOS voice session, plus MCP, hooks, and skills variants |
| [`examples/swift/Cartographer`](examples/swift/Cartographer) | A GUI macOS agent app |

## Repository layout

```
cosmo-ai/
├── typescript/   # cosmo-ai (npm) — web & React SDK
├── python/       # cosmo-ai-sdk (PyPI) — asyncio SDK
├── swift/        # CosmoRealtime — Swift SDK (macOS & iOS)
├── examples/     # runnable examples for all three SDKs
└── skills/       # the Agent Skill for coding agents
```

## Support

- [Documentation](https://platform.askcosmo.ai/docs) — getting started, the
  credential model, per-language reference, and the changelog
- [GitHub issues](https://github.com/socratic-ai/cosmo-ai/issues) — bugs and
  feature requests for any SDK or example
- Example fixes and new examples are welcome as pull requests

## License

Licensed under the [Apache License, Version 2.0](LICENSE). Copyright 2026
Socratic AI, Inc.
