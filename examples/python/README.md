# Python examples

Runnable scripts that each demonstrate one surface of the
[`cosmo-ai-sdk`](https://pypi.org/project/cosmo-ai-sdk/) realtime API. All of
them are text-first — no microphone or speaker needed — except `voice_cli`,
which is a real two-way voice call.

## Setup

```bash
pip install cosmo-ai-sdk cosmo-cli
cosmo login                 # or: export COSMO_API_KEY=cosmo_...
```

The SDK targets `https://platform.askcosmo.ai` by default; set `COSMO_BASE_URL`
to point at another backend.

## The examples

| Example | Shows |
|---|---|
| `hello_realtime.py` | The core loop: an inline agent with one client tool, a text turn, and the typed event stream printed as it arrives. |
| `deep_thinker.py` | Background client tools: a hard question is delegated to a more capable reasoning model while the agent keeps talking, and the answer is announced when it lands. Needs `pip install anthropic` and `ANTHROPIC_API_KEY`. |
| `hooks_agent.py` | Hooks: deny a destructive tool and log every tool outcome. |
| `mcp_agent.py` | Tools from a local stdio MCP server (`pip install 'cosmo-ai-sdk[mcp]'` and Node for `npx`; the server list lives in `mcp.json`). |
| `skills_agent.py` | Skills loaded just-in-time from the `SKILL.md` files under `skills/`. |
| `skills_text_test.py` | Skills end-to-end over one text turn, printing the moment `cosmo_sdk_load_skill` fires. |
| `outbound_call.py` | An outbound phone call via `session.dial` — the callee joins as a SIP participant (requires phone calls enabled on the workspace). |
| `voice_cli/` | A real voice call from your terminal, mic and speaker included — see its [README](voice_cli/README.md). |

Each script's docstring carries its exact invocation.
