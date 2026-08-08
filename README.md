# Cosmo AI

Realtime voice and multimodal agent SDKs from [Socratic AI](https://askcosmo.ai):
live sessions where an agent listens, speaks, calls tools, runs skills, and
dials phones.

This is the starting point for building on Cosmo. SDK source code lives in the
per-language repositories below; this repository holds the runnable examples
under [`examples/`](examples/).

## SDKs

| Language | Repository | Install |
| --- | --- | --- |
| TypeScript (web & React) | [cosmo-typescript-sdk](https://github.com/socratic-ai/cosmo-typescript-sdk) | `npm install cosmo-ai` |
| Python | [cosmo-python-sdk](https://github.com/socratic-ai/cosmo-python-sdk) | `pip install cosmo-ai-sdk` |
| Swift (macOS & iOS) | [cosmo-swift-sdk](https://github.com/socratic-ai/cosmo-swift-sdk) | Swift Package Manager |

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
| [`examples/python`](examples/python) | Minimal session (`hello_realtime.py`), a terminal voice client (`voice_cli`), outbound calling, and hooks / skills / MCP agents |
| [`examples/swift/HelloRealtime`](examples/swift/HelloRealtime) | Minimal macOS voice session, plus MCP, hooks, and skills variants |
| [`examples/swift/Cartographer`](examples/swift/Cartographer) | A GUI macOS agent app |

## Issues and contributions

SDK bugs go to the matching language repository above. Example fixes and new
examples are welcome here as pull requests.

## License

Licensed under the [Apache License, Version 2.0](LICENSE). Copyright 2026
Socratic AI, Inc. The example code in this repository is provided under the same
license; each example depends on the published Cosmo SDK packages.
