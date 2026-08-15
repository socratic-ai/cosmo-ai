# Cosmo AI

Realtime voice and multimodal agent SDKs from [Socratic AI](https://askcosmo.ai):
live sessions where an agent listens, speaks, calls tools, runs skills, and
dials phones.

This is the home of the Cosmo SDKs: the TypeScript, Python, and Swift source,
the runnable examples, and the agent skill all live here. Issues and
contributions for any of them belong here too.

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

## Issues and contributions

Bugs and feature requests for any SDK or example belong on this repository's
issue tracker. Example fixes and new examples are welcome as pull requests.

## License

Licensed under the [Apache License, Version 2.0](LICENSE). Copyright 2026
Socratic AI, Inc.
