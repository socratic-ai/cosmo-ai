# Core model and cross-SDK rules

The docs are the source of truth for the full API surface:
https://platform.askcosmo.ai/docs (agents: `/docs/llms.txt`,
`/docs/llms-full.txt`, MCP endpoint at `/docs/api/mcp` — all three live
under `/docs`; the site root serves the app, not the agent files). This
file carries only what coding
agents get wrong on their own: the credential rules and cross-SDK
gotchas. Language-specific layers: [typescript.md](typescript.md),
[python.md](python.md), [swift.md](swift.md).

## The three objects

- **client** — the connection: credential, endpoint, transport. Reusable.
- **agent** — the persona: instructions, model, voice, tools, turn-taking.
  Immutable; to vary a field, build another agent.
- **session** — one live run. An async iterator of typed events.

## Credentials — the rule that matters most

| Credential | Where it may live | Can |
|---|---|---|
| **API key** (`cosmo_…`) | your server, your laptop | open sessions, mint tokens |
| **Minted JWT** | a browser, a phone, any shipped client | open sessions only |

**Never put an API key in code that ships to a user** — not behind a
`VITE_`/`NEXT_PUBLIC_` variable either; bundlers inline those.

**How the SDK resolves an API key** (identical chain in all three): an
explicitly passed credential wins; else `COSMO_API_KEY`; else the
`cosmo login` credentials file (`COSMO_CREDENTIALS_FILE` or
`~/.cosmo/credentials`, profile from `COSMO_PROFILE`). A stored
credential carries the backend it was issued for; a conflicting
`COSMO_BASE_URL` is refused up front (`base_url_mismatch`). Nothing
usable → the `CredentialsError` family with a `cosmo login` remediation.
Re-running `cosmo login` mints a replacement key and retires the old one.

Minting end-user tokens is the productionization step — don't scaffold it
for a prototype. When the app ships:
[end-user-tokens.md](end-user-tokens.md).

There is no `baseUrl` constructor option in any SDK: the backend comes
from `COSMO_BASE_URL` (or a `cosmo-base-url` meta tag on Cosmo-served
pages), defaulting to `https://platform.askcosmo.ai`.

## Cross-SDK gotchas

- **A voice is the provider's own** (`Aoede` / `Puck` on Gemini,
  `shimmer` / `cedar` on OpenAI, a catalog id on Cosmo Voice). Nothing is
  translated between providers, so a voice picked for one means nothing to
  another. **An unrecognized voice does not raise** — the server falls back
  to that provider's default and logs a warning, so a typo ships as the
  wrong voice, never as an error. Spell exactly.
- **Iteration is the way to observe a session** (`async for` /
  `for await` / `for try await`). Unknown frames surface as
  `UnknownEvent` and are never fatal; `SessionEndedEvent` is always
  the last item — don't add your own sentinel.
- **A non-fatal in-stream `ErrorEvent` does not end the session** —
  don't tear down on every error event. `VersionMismatchError` at
  construction means upgrade the SDK, not retry.
- **Client tools come in two kinds, and the plain one blocks.** A regular
  client tool's reply is whatever its handler returns, so the conversation
  waits for it and the server abandons the call after about ten seconds.
  Anything slower than a beat of conversation is a **background client
  tool** instead: the handler takes a second argument, a per-invocation
  job handle, acks to release the reply so the agent can keep talking,
  and delivers the outcome later — `@tool(background=True)` (Python),
  `tool({ background: true, ... })` (TypeScript),
  `SessionConfig.Tool.defineBackground` (Swift). Same declaration, same
  wire shape; the handler signature is the whole difference. Reach for it
  before wrapping a slow tool in a timeout or splitting it into a poll.
- **A declared tool with no handler and no server execution is rejected**,
  surfaced in `ReadyEvent.rejected_tools` — check it instead of
  wondering why a tool is never called.
- **`session.dial(phone_number)` needs an API-key session** — minted
  end-user tokens cannot dial.

## Beyond the basics

Hooks (lifecycle interception), agent skills (`SKILL.md`-defined
capabilities), MCP servers as tool sources, and outbound telephony exist
in every SDK — the docs cover each, and runnable versions live in the
[cosmo-ai examples](https://github.com/socratic-ai/cosmo-ai). Start from
the closest example.
