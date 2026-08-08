# HelloRealtime

Terminal examples for the `CosmoRealtime` Swift SDK — one package, five
executables, each a headless live proof of one surface:

| Target | Shows |
|---|---|
| `HelloRealtime` | The core session loop: `RealtimeSession.start`, one typed client tool, and the event stream drained to the terminal. |
| `BackgroundToolExample` | A blocking client tool and a background one side by side: `defineBackground` acks through its `ClientToolJob`, the agent keeps talking, and the result arrives when the work finishes. |
| `HooksExample` | All four hooks in one session: inject context at session start, deny one tool, rewrite another's arguments, observe every outcome. |
| `MCPExample` | Tools from a local stdio MCP server — loads `mcp.json` (override with `COSMO_MCP_CONFIG`) and watches the model call `mcp__<server>__<tool>`. Needs Node for `npx`. |
| `SkillsExample` | One hot skill declared in code; watch `cosmo_sdk_load_skill` fire and the model follow the skill body. |

## Run

Requires macOS 13+ and a credential — either sign in once with `cosmo login`
(the CLI installs with `pipx install cosmo-cli`) or export a workspace API key:

```bash
export COSMO_API_KEY=cosmo_...   # optional after `cosmo login`
swift run HelloRealtime
swift run BackgroundToolExample   # COSMO_EXPORT_SECONDS=12 sets the fake work length
swift run HooksExample
swift run MCPExample
swift run SkillsExample
```

The package builds against the published `cosmo-swift-sdk`; inside a checkout
that has the SDK sources as a sibling it uses those automatically (see the
probe in `Package.swift`).
