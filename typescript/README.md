# cosmo-ai

TypeScript SDK for Cosmo realtime voice and multimodal sessions, backed by LiveKit.

## Installation

```bash
npm install cosmo-ai
```

`livekit-client` carries the media transport and is a required peer
dependency. npm 7+ and pnpm 8+ install it for you; Yarn does not, so name it
explicitly there:

```bash
yarn add cosmo-ai livekit-client
```

It is a peer rather than a bundled dependency so an app that already uses
`livekit-client` directly shares a single copy. Two copies would mean two
media stacks — each with its own workers — contending for the same
microphone.

`react` and `react-dom` (`^19`) are required peer dependencies. npm 7+
installs them automatically; with yarn or pnpm run
`yarn add react react-dom` alongside the SDK.

> **Beta.** `cosmo-ai` is pre-1.0: minor releases may contain breaking
> changes, noted in the
> [changelog](https://platform.askcosmo.ai/docs/meta/changelog). Pin a
> minor (`"cosmo-ai": "~0.6.0"`) if
> you need stability. We will cut 1.0 once the session, tool, and React
> APIs have gone several releases without breaking changes.

## Teach your agent

One [Agent Skill](https://agentskills.io) covers the whole Cosmo SDK
family (TypeScript, Python, Swift): the current SDK API, the credential
and login rules, and the deploy/share playbook. It teaches coding agents
(Claude Code, Cursor, Codex CLI, Gemini CLI, …) — install it once per
machine or project:

```bash
npx skills add socratic-ai/cosmo-ai
```

Prefer it to track your installed package version automatically? Add
[`skills-npm`](https://github.com/antfu/skills-npm) as a dev dependency and
run `npx skills-npm setup` once — every `npm install` then links the skill
out of `node_modules`.

Agents can also read the docs directly:
https://platform.askcosmo.ai/docs (`/llms.txt`, `/llms-full.txt`, and an
MCP endpoint at `/docs/api/mcp`).

## Quickstart

Three objects, one per concern of running a session:

- **`RealtimeClient`** — the connection: credential, endpoint, transport.
- **`RealtimeAgent`** (`client.agent({...})`) — the persona/configuration of
  the model (instructions, model, voice, tools, speaking style), reusable
  across sessions.
- **`RealtimeSession`** (`await agent.start(...)`) — one live run plus its
  per-run, transport-level options (resume, recording opt-out, observer
  join). The persona — including its `greeting` and audio handling — rides
  unchanged from the agent.

```ts
import { RealtimeClient } from 'cosmo-ai';

// Construct with at most one credential: an `apiKey` (workspace-scoped,
// server-side only — can also mint end-user tokens via `client.mintToken`)
// or a `token` (a minted end-user JWT, safe on end-user devices). Never
// both. On Node, passing neither resolves an API key automatically:
// `COSMO_API_KEY` from the environment, else the `cosmo login` credentials
// file (`~/.cosmo/credentials`, profile from `COSMO_PROFILE`; the CLI
// installs with `pipx install cosmo-cli`), which also
// carries the backend the key was issued for. A browser page must receive a
// minted `token`, never a `cosmo_…` key — pass `TokenSource.endpoint(url)`
// as the `token` and the SDK fetches and refreshes the JWT itself (see
// "From a browser"). The backend otherwise comes from
// `COSMO_BASE_URL` (see "Choosing a backend"), and the server resolves the
// workspace and project from the credential — nothing else to configure.
const client = new RealtimeClient({
  token: '<minted-end-user-token>',
});

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

End a run with `await session.end()` — the stream always finishes with a
final `session-ended` item.

### Agents are immutable

An agent is frozen once built, and opens any number of sessions. To vary a
persona field, build another agent — `client.agent({...})` is cheap.

```ts
const terse = client.agent({
  instructions: 'Answer in one sentence.',
  voice: 'Puck',
  greeting: 'Hi, how can I help?',
  audio: { noiseCancellation: true },
});

const session = await terse.start();
```

`greeting` and the `audio` pipeline are persona fields — what the
agent says to open a call and how its audio is handled, configured
once, not per run.

`audio.noiseCancellation` is off by default: the agent hears the raw
microphone signal. Set it to `true` when the microphone will hear more than
one voice — a café, an open office, a TV in the background. The isolated
signal is what the agent hears *and* what turn-taking reads, so turning it
on can shift endpointing; measure it on your own audio before leaving it on.
The default is the server's — leave `audio` unset and the SDK sends no audio
block at all.

### Tools

`tools` on the agent takes client-executed specs (`kind: 'client'`) and
typed server-tool opt-ins, executed server-side: `{ kind: 'web_search' }`,
`{ kind: 'examine_image' }`, `{ kind: 'detect_objects' }`, `{ kind: 'point_at_object' }`,
`{ kind: 'end_call' }` (the agent hangs up itself) — each zero-config; the server
owns the model-facing declaration.
Attach a `handler` to a client spec and the SDK executes it when the agent
calls the tool — decoding the arguments, running your async function, and
reporting the returned object (or thrown error) back to the model. A spec
without a handler is still declared but not locally executable. Specs the
server refuses are echoed on the `ready` event's `rejectedTools`; the
session still starts without them.

Prefer the typed builder: one runtime schema drives the model-facing JSON
Schema, runtime validation, and the handler's argument types. It ships as
the subpath `cosmo-ai/tool`; the Zod converter is its own further
entry `cosmo-ai/tool/zod` (`zod` is an optional peer dependency, `^4` —
author schemas via the `zod/v4` subpath).

```ts
import { tool } from 'cosmo-ai/tool';
import { zodInput } from 'cosmo-ai/tool/zod';
import { z } from 'zod/v4';

const getWeather = tool({
  name: 'get_weather',
  description: 'Current weather for a city',
  input: zodInput(
    z.object({
      city: z.string().describe('City name'),
      unit: z.enum(['c', 'f']).default('c'),
    }),
  ),
  handler: async ({ city, unit }) => ({ tempC: await lookup(city, unit) }),
});

const agent = client.agent({
  tools: [getWeather, { kind: 'web_search' }],
});
```

The emitted schema is checked against the backend's restricted JSON-Schema
dialect when `zodInput()` / `tool()` runs, so a schema the server would
reject throws `ToolSchemaError` at startup instead of surfacing as a
`ready.rejectedTools` entry at connect (`zodInput(schema, { name: 'get_weather' })`
labels that error with the tool it is for). Constructs the dialect cannot
express (`pattern`/`format`/regex, `oneOf`, strict objects, records,
exclusive bounds, array-length bounds) throw rather than being silently
dropped. A malformed model call becomes a sanitized `INVALID_INPUT` tool
error (structured paths + constraints, never submitted values) before your
handler runs, so the model can self-correct. Validation semantics are Zod's
own — defaults fill, transforms run: the emitted schema describes the
**accepted input**, the handler receives the **validator's output**.

Raw JSON Schema stays available as the advanced escape hatch — hand-written
dialect `parameters`, args typed `Record<string, unknown>`, no validation
(the dialect check still runs at construction). The plain spec-object form
below is equivalent. For a validating vendor the builder has no converter
for, `tool({ input: someStandardSchema, unsafeParameters: {...} })` accepts
any Standard Schema V1 validator — the field name is the warning: nothing
keeps the validator and the model-facing schema in agreement.

```ts
const agent = client.agent({
  tools: [
    {
      kind: 'client',
      name: 'get_local_time',
      description: 'Returns the local wall-clock time.',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => ({ time: new Date().toLocaleTimeString() }),
    },
    { kind: 'web_search' },
  ],
});
```

A tool whose work outlives a conversational beat (an export, a long fetch)
is declared with `background: true` — on the builder
(`tool({ background: true, input, handler: (args, job) => … })`) or on the
raw spec: the handler acks the call immediately — the agent speaks the note
and the conversation continues — and delivers its result later through the
job handle. The same shape exists in the Python (`BackgroundClientTool`)
and Swift SDKs.

```ts
const agent = client.agent({
  tools: [
    {
      kind: 'client',
      background: true,
      name: 'export_report',
      description: 'Exports the report and returns a download URL.',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async (args, job) => {
        job.ack('Starting the export…');
        const url = await heavyExport(args);
        await job.complete({ result: { url }, summary: 'The report is ready.' });
      },
    },
  ],
});
```

`complete` / `fail` reject when the terminal publish fails, leaving the job
retryable; a terminal call after the session has ended is dropped.

`hooks` on the agent fires at the session's four seams: `SessionStart`
(inject `additionalContext` into the instructions before the session
opens), `PreToolUse` (deny or rewrite a call before the handler runs),
`PostToolUse` (observe the outcome the model saw), and `SessionEnd` (fires
exactly once when the session ends, on any exit path). Matchers use the cross-SDK glob
grammar (`*`, `?`, `[seq]`, `[!seq]`), case-sensitive over the full tool
name.

Declare a hook with the seam's factory — the returned `Hook` goes in the
agent's `hooks` list; list order is fold order. The same list also carries
**server hooks** — declarative `SilenceTimeout` rules the server executes
even if this process dies mid-call. A fired server hook reaches you as a
`user_speech_timeout` event on the session, not as a hook.

```ts
import { preToolUse, sessionEnd, sessionStart } from 'cosmo-ai';

const agent = client.agent({
  tools,
  hooks: [
    sessionStart(() => ({ additionalContext: 'Caller is a VIP.' })),
    preToolUse(() => ({ permission: 'deny', reason: 'read-only mode' }), {
      matcher: 'delete_*',
    }),
    sessionEnd((ctx) => console.log('ended:', ctx.reason)),
    { trigger: 'user.speech.timeout', timeout_seconds: 45, action: { type: 'end_call' } },
  ],
});
```

`skills` on the agent serves just-in-time instructions: an array of
`Skill` objects (`{name, description, body}`) — inline, or parsed from
Agent Skills `SKILL.md` documents with `parseSkillMd` (load the text from
wherever it lives: bundled assets, OPFS, a CMS fetch). The agent folds the
skill menu into its instructions and declares a `cosmo_sdk_load_skill` tool
that returns a skill's body on demand. Duplicate names throw when the agent
is built; a malformed document raises `SkillParseError` at parse.

```ts
const agent = client.agent({
  skills: [parseSkillMd(billingMd, { defaultName: 'billing' })],
});
```

## Consumption models

A session is observable two ways — pick per consumer:

- **Async iteration** — `for await (const event of session)` yields the
  wire-level event stream. Two guarantees: **unknown ≠ fatal** (a frame with
  an unrecognized `type` surfaces as `{ type: 'unknown' }` and the stream
  continues) and **`session-ended` is always the final item** (synthesized
  on `session.end()` / transport close; after it, iteration finishes).
  Single consumer per session.
- **Callbacks** — `session.on('transcript', ...)` with the same typed,
  UI-normalized event map `RealtimeClient` emits (`transcript`, `ready`,
  `lifecycle`, `error`, …). This is what the React hooks build on; any
  number of subscribers.

The two surfaces use different vocabularies on purpose: iteration yields
wire-level frames and mirrors the wire protocol's kebab-case names
(`{ type: 'session-ended' }`), while callbacks are the SDK's normalized
UI layer with snake_case names (`session_ended`). Two guarantees the
callback layer makes:

- **`session_ended` fires exactly once per session, on any exit path** —
  server end, client `end()`, or transport failure — carrying the
  server's reason slug or the disconnect reason (e.g. `client_ended`).
  A "call over" UI keyed here (or to `lifecycle`) sees every ending.
- **Late subscribers miss nothing.** The current `lifecycle` state (and
  an already-fired `ready`) are replayed on subscribe, so attaching
  handlers after `await agent.start()` resolves just works.

`session.state` exposes the formal connection lifecycle
(`idle → connecting → connected ↔ reconnecting → disconnected`) with a typed
`disconnectReason` (`client_ended`, `server_ended`, `handshake_failed`,
`transport_error`, …) once disconnected.

## On a server

Server code that runs under the `react-server` bundler condition — Next.js
route handlers and server components — cannot load the root entry, because
it exports the React bindings (`createContext is not a function` at import).
Use the React-free `cosmo-ai/server` entry there:

```ts
import { RealtimeClient } from 'cosmo-ai/server';

const client = new RealtimeClient({ apiKey: process.env.COSMO_API_KEY });
const minted = await client.mintToken(externalUserId); // { jwt, expiresAt }
```

It exports the client plus the mint/verify types and nothing React. Plain
Node processes (Express, scripts) load either entry; `cosmo-ai/server` is
the safe default for any code that never renders.

## From a browser

The Cosmo API accepts requests from any origin — your production domain, a
preview deployment, `http://localhost:5173` during development — so a page
holding a minted `token` calls it directly, with no proxy of your own.
Point a `TokenSource` at your minting endpoint and the SDK fetches and
refreshes the JWT itself:

```ts
const client = new RealtimeClient({
  token: TokenSource.endpoint('https://your-backend.example.com/token'),
});
```

A raw JWT string (`{ token: jwtFromYourServer }`) works too — refresh is
then yours to handle. The [token-server
example](https://github.com/socratic-ai/cosmo-ai/tree/main/examples/typescript/token-server)
is a deployable zero-dependency minting endpoint if you don't have a backend
yet.

## Choosing a backend

The SDK resolves the Cosmo backend itself; there is no URL to pass. It reads
`COSMO_BASE_URL`, and falls back to `https://platform.askcosmo.ai`.

A browser has no environment to read, so a page names its backend with a
`<meta>` tag — which is how the Cosmo web app points the SDK at whichever
host served the page:

```html
<!-- absent: use https://platform.askcosmo.ai -->
<meta name="cosmo-base-url" content="https://platform.askcosmo.ai" />
<meta name="cosmo-base-url" content="" /><!-- empty: this page's own origin -->
```

Set it explicitly if your key's workspace does not live on
`platform.askcosmo.ai` — Cosmo also serves `https://assistant.askcosmo.ai`, a
separate member-facing surface with its own workspaces, and a key minted on
one surface fails as a `401` on the other.

`http://` is rejected for any host but `localhost` / `127.0.0.1`, so a
misconfigured backend cannot carry your credential in plaintext.

The credential is the only boundary: these endpoints read `Authorization` and
never a cookie, so no cookies ride along with the request. Mint on your
server, never in the page — the `apiKey` that mints tokens must not ship to a
browser.

If a call fails before the server answers, the browser reports every cause —
DNS, TLS, offline, a rejected CORS preflight — as the same bare
`TypeError: Failed to fetch`. The SDK detects the cross-origin case and says
so in the error message; the network tab's `OPTIONS` request is where a
preflight rejection shows up.

## React usage

The provider is fed one live run — pass it the `RealtimeSession` from
`agent.start()` (or from the `useRealtimeSession` hook), and `null`
between runs:

```tsx
import { RealtimeProvider, useTranscript, type RealtimeSession } from 'cosmo-ai';

function App({ session }: { session: RealtimeSession | null }) {
  return (
    <RealtimeProvider session={session}>
      <Transcript />
    </RealtimeProvider>
  );
}

function Transcript() {
  const items = useTranscript();
  return <ul>{items.map((item) => <li key={item.id}>{item.text}</li>)}</ul>;
}
```

## Features

- **Audio streaming** — microphone capture, output playback, volume meters (`useMicLevel`, `useOutputLevel`), plus `startAudioStream` to publish a `MediaStream` you own (Web Audio, WAV replay, a non-default device)
- **Video / screen share** — track management via LiveKit with `ScreenShareState`
- **Tool calls** — handle and respond to model-initiated tool invocations (`useToolCalls`, `ToolCallEvent`)
- **React hooks** — `useTranscript`, `useAgentState`, `useTransportState`, `useRealtimeError`, and more
- **React components** — `RealtimeAudio`, `MicToggle`, `BarVisualizer`, `StartAudio`
- **Event emitter API** — `session.on(eventName, handler)` for headless usage

## Text turns and context notes

Two different things, two different calls:

```ts
// Asks. The agent answers, out loud.
await session.sendText('What does section 6 say?');

// Tells. The agent knows this next time it answers, and says nothing now.
await session.sendContext(`now on ${label} (section ${n} of ${total}).`);
```

`sendContext` is for live application state — scroll position, selection,
current record, form values. The note reaches the model on a channel that
never requests a response, so it cannot produce a turn, cannot interrupt what
the agent is saying, and adds nothing to `useTranscript()`. Push them as
often as your UI changes.

`sendText` takes one option, and it does not turn the send into a context
note: `transcript: false` skips the optimistic `transcript` event the SDK
otherwise emits for the sent text. The turn still happens.

The agent replies in whatever modality the session runs in. There is no
per-turn way to suppress speech; configure the agent with `audio.output =
false` for a session that never speaks.

## Verifying a credential

`client.verify()` checks a credential without starting a session — no room, no
agent, no charge. Use it as a startup check or a CI smoke test.

```ts
const info = await client.verify(); // throws RealtimeVerifyError if rejected

info.workspace?.slug;         // which workspace (and so which environment)
info.scopes;                  // e.g. ['realtime:use']
info.canStartSessions;        // false -> valid credential, missing realtime:use
info.realtimeVoiceAvailable;  // false -> no default voice stack configured here
```

Works with either credential; a minted token also reports the `externalUserId`
it is bound to, and gets a null `workspace` — it runs on an end user's device,
which is not told whose workspace it belongs to. An under-scoped credential is
a returned fact, not a throw — only a credential the server rejects throws.

## Session usage

`session.usage()` fetches the session's usage summary over REST — during the
session or after it ends.

```ts
const usage = await session.usage(); // throws UsageError if rejected

usage.usageStatus;      // 'pending' until the summary lands, then 'recorded' — or
                        // 'unavailable' when none was written and none will be
usage.durationSeconds;  // wall-clock span; null while the session is live
usage.turnCount;        // model-response turns
usage.tokens;           // token counts by direction and modality; null when the provider reports none
```

`client.getSessionUsage(sessionId)` is the client-level form for a session id
you stored earlier.

## Outbound calling

`session.dial(phoneNumber)` places an outbound phone call **into a running
session**: the dialed party joins the session's room as a SIP participant and
the agent — already in the room — converses with them. Starting a session and
choosing who is on the call are separate, explicit steps.

```ts
const client = new RealtimeClient({ token });

const session = await client.agent({ instructions: 'You are Alex.' }).start();
await session.waitUntilReady();

const { dialId } = await session.dial('+14155550199'); // bring the callee in over SIP
```

- **Number format** — E.164 (`+` then 8–15 digits); the SDK fast-fails a
  malformed number with `RealtimeDialError` (`code: 'invalid_phone_number'`)
  before any request.
- **Enablement** — outbound calling must be enabled for the workspace
  (`phone_calls_disabled` otherwise); the same credential that opened the
  session authorizes the dial.
- **Limits** — calls count against the workspace's weekly per-user minute limit
  (`minute_limit_exceeded`).
- **Errors** — server rejections throw `RealtimeDialError` with the server's
  slug (`phone_calls_disabled`, `minute_limit_exceeded`, `session_not_live`, …).
- **Return** — `DialResult` (`{ dialId }`), a handle to the queued call. The
  call rings asynchronously; watch the session's events for the conversation.

## React Hooks

| Hook | Description |
|---|---|
| `useRealtimeSession()` | Session lifecycle: a single-use client per run, `start`/`end`, one teardown on every exit path (used above the provider) |
| `useRealtimeSessionContext()` | Access the provider's `RealtimeSession` (`null` between runs) from context |
| `useTransportState()` | LiveKit transport connection state |
| `useAgentState()` | Cosmo agent lifecycle state |
| `useTranscript()` | Array of transcript items (user + agent turns) |
| `useToolCalls()` | Pending and completed tool call items |
| `useMicLevel()` | Microphone input volume (0–1) |
| `useOutputLevel()` | Agent audio output volume (0–1) |
| `useRealtimeError()` | Latest `RealtimeError`, if any |

## Documentation

Start with the [documentation](https://platform.askcosmo.ai/docs) — getting
started, the credential model, and the expected session lifecycle. Full API
reference ships with the SDK package.

## License

Licensed under the [Apache License, Version 2.0](./LICENSE). Copyright 2026
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
