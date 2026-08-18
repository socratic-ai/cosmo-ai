# cosmo-ai-sdk (Python)

Async SDK for the Cosmo Realtime external API.
One call starts a session (REST session-start + LiveKit room join); the
session is an async iterator of typed events. Audio I/O rides the LiveKit
room at the platform layer.

> New to the SDK? Start with the [documentation](https://platform.askcosmo.ai/docs)
> — getting started, the credential model, and the expected session lifecycle.

---

## Install

```bash
pip install cosmo-ai-sdk
```

> **Beta.** The SDK is pre-1.0: minor releases may include breaking API
> changes, called out in the
> [changelog](https://platform.askcosmo.ai/docs/meta/changelog). We will tag 1.0 once the session
> event stream, tool authoring, and credential APIs have gone a full release
> cycle without breaking changes. Pin a minor version (e.g.
> `cosmo-ai-sdk~=0.5.0`) if you need stability.

Requires Python 3.10+. One install covers everything: the media transport
(`livekit>=1.1.12`), microphone capture via `set_microphone_enabled`, and
speaker playback via `set_speaker_enabled` (`sounddevice`) are included. Two
platform notes: `livekit` is a native wheel published for macOS, glibc Linux
(x86_64/aarch64), and Windows x64 — on musl-based images (e.g. Alpine) there
is no wheel, so use a `python:*-slim` base instead. And on Linux, speaker
playback needs PortAudio from your distribution — the `sounddevice` wheel
bundles it on macOS and Windows, but the Linux wheel does not, and pip cannot
install a system C library. Without it `set_speaker_enabled` raises
`AudioUnavailableError`, as does `set_microphone_enabled` on any host with no
usable input device. Servers that never touch OS audio don't need it.

---

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

Three objects, one per concern of running a session:

- **`RealtimeClient`** — the connection: credential, endpoint, HTTP transport.
- **`RealtimeAgent`** — the persona/configuration of the model (instructions, model,
  voice, tools, turn-taking), reusable across sessions.
- **session** (`agent.start(...)`) — one live run plus its per-run,
  transport-level options (resume, recording opt-out, lifecycle observer).

```python
import asyncio
from cosmo_ai import (
    RealtimeClient,
    ReadyEvent,
    SessionEndedEvent,
    TranscriptDeltaEvent,
    TranscriptRole,
    UsageEvent,
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
                    # Compare against the enum, not a bare string.
                    who = "agent" if event.role is TranscriptRole.ASSISTANT else "you"
                    print(f"[{who}] {event.text}")
                case UsageEvent():
                    print(f"tokens so far: {event.total_tokens}")
                case SessionEndedEvent():
                    print(f"ended: {event.reason}")
                    break

asyncio.run(main())
```

The stream stays open until the session ends, so `break` on the event you were
waiting for — otherwise the loop simply keeps waiting.

See `hello_realtime.py` in the [examples repo](https://github.com/socratic-ai/cosmo-ai/tree/main/examples/python) for the runnable
text-only demo and `voice_cli/` there for a live two-way voice call
(microphone in, agent audio out).

The client talks to `https://platform.askcosmo.ai` by default. For local
development against another backend, set the `COSMO_BASE_URL` environment
variable (`http://` is allowed only for localhost).

---

## Credentials & end-user tokens

Construct the client with at most one credential:

- **`api_key`** — workspace-scoped, **secret, server-side only**. Can mint
  end-user tokens and open sessions.
- **`token`** — a minted end-user JWT scoped to one external user. Safe to
  hand to a browser/device; can open sessions but cannot mint. Pass a
  `TokenSource` instead of the raw string and the SDK fetches the JWT from
  your minting endpoint itself, re-fetching as expiry nears.
- **Neither** — `RealtimeClient()` resolves an API key itself: `COSMO_API_KEY`
  from the environment, else the `cosmo login` credentials file
  (`COSMO_CREDENTIALS_FILE` or `~/.cosmo/credentials`, profile from
  `COSMO_PROFILE`). The `cosmo` CLI installs with `pipx install cosmo-cli`.
  A stored credential brings along the `base_url` it was
  issued for; a `COSMO_BASE_URL` naming a different backend is refused
  rather than obeyed. Raises `CredentialsError`
  (`CredentialsNotFoundError` / `CredentialsFileError` /
  `CredentialsExpiredError`) when nothing usable resolves.

For multi-user apps, mint on your backend and connect on the client:

```python
# 1) Backend (api key) — mint a short-lived token for an end user
backend = RealtimeClient(api_key="cosmo_...")
minted = await backend.mint_token("user-123")   # -> {jwt, expires_at}; send minted.jwt to the user

# 2) End-user app (no key) — the SDK fetches the JWT from your endpoint
client = RealtimeClient(token=TokenSource.endpoint(
    "https://your-backend.example.com/token",
    headers={"Authorization": f"Bearer {app_session}"},
))
async with client.agent(instructions="...").start() as session:
    async for event in session:
        ...
```

`TokenSource.endpoint` POSTs the URL (empty JSON body) and reads
`{jwt, expires_at}` — the shape a forwarded `mint_token` response already
has; the token is cached and re-fetched inside a 60-second expiry margin.
`TokenSource.custom(fetch)` takes any async fetcher instead, and a raw
string (`token=minted.jwt`) still works when you already hold a JWT.
`mint_token` is idempotent per `(workspace, external_user_id)` — the same
external user maps to the same auto-provisioned project. The `api_key` never
leaves your server; the end-user app only holds the short-lived, per-user JWT.

### Verifying a credential

`verify()` checks a credential without starting a session — no room, no agent,
no charge. Use it as a startup check or a CI smoke test:

```python
info = await client.verify()          # raises VerifyError if the credential is bad
info.workspace                        # which workspace (and so which environment)
info.scopes                           # e.g. ["realtime:use"]
info.can_start_sessions               # False -> valid credential, missing realtime:use
info.realtime_voice_available         # False -> no default voice stack configured here
```

It works with either credential; a minted token also reports the
`external_user_id` it is bound to, and gets `workspace=None` — it runs on an
end user's device, which is not told whose workspace it belongs to. An
under-scoped credential is a returned fact, not an exception — only a
credential the server rejects raises.

For a private-CA / self-signed https backend (or proxies, mTLS, custom
transport), point the SDK at it with `COSMO_BASE_URL` and supply your own
`httpx.AsyncClient` via `http_client` — it controls TLS/transport. An injected
client is yours: the SDK uses it but never closes it on `aclose()`, and it
applies its own timeout to session-start/mint requests so your client's timeout
won't shorten them.

```python
import httpx
# COSMO_BASE_URL=https://internal.example
client = RealtimeClient(
    api_key="cosmo_...",
    http_client=httpx.AsyncClient(verify="/etc/ssl/corp-ca.pem"),
)
```

---

## Consumption model

`async for event in session` is **the** way to observe a session. The stream
yields the `RealtimeSessionEvent` union — `ready`, `transcript`,
`model-text`, `turn-complete`, speaking/LLM/TTS phase events, the tool
lifecycle (`tool-call`, `tool-dispatch-started`, `tool-result`,
`tool-invocation`), `reconnecting`, `error`, `pong`, `cosmo.usage` — all
Pydantic models discriminated by `type`.

Transcript roles are `TranscriptRole.USER` / `.ASSISTANT`, whose values
are lowercase (`"user"` / `"assistant"`). The wire spells them uppercase and
decoding accepts either casing, so compare against the enum member rather than
a string literal.

`UsageEvent` (`cosmo.usage`) carries **cumulative** token counts for the
session, split by direction and modality — each event supersedes the last. A
provider that reports no usage emits none, so absence is not zero.

Two guarantees:

* **Unknown ≠ fatal.** A frame with an unrecognized `type` (or one that
  fails validation) surfaces as `UnknownEvent(raw_type=...)` and the stream
  continues. Undecodable frames surface as `UnknownEvent(raw_type=None)`.
* **`SessionEndedEvent` is always the final item.** An SDK-local terminal
  sentinel synthesized on `session.end()` / context-manager exit / transport
  close. The server's own best-effort `session-ended` frame never surfaces
  mid-stream — its reason is latched and carried by the terminal sentinel
  (with a short grace teardown if the room close never follows). After it,
  iteration finishes.

Oversized server messages arrive as `server-envelope-chunk` frames; the SDK
reassembles them transparently — chunks never surface as events.

## Logging

The SDK logs nothing by default. Its loggers sit under the `cosmo_ai` stdlib
namespace behind a `NullHandler`, so diagnostics never interleave with your
own output until you ask for them:

```python
import logging

logging.basicConfig()
logging.getLogger("cosmo_ai").setLevel(logging.DEBUG)
```

Records carry structured key/value context (the SDK uses `structlog`), and an
app that configures `structlog` gets them rendered in its own format.

## Public API

### `RealtimeClient`

| Member | Description |
|---|---|
| `RealtimeClient(api_key=... \| token=..., http_client=None)` | Construct with at most one credential — with neither, the SDK resolves `COSMO_API_KEY`, then the `cosmo login` credentials file (see [Credentials](#credentials--end-user-tokens)). The base URL defaults to `https://platform.askcosmo.ai`; override it with the `COSMO_BASE_URL` environment variable for local development. `http_client` injects your own `httpx.AsyncClient` (custom CA/TLS, proxies, mTLS, transport) — the SDK uses but never closes it. Reuse across sessions; close the owned client with `aclose()` / `async with` |
| `agent(*, instructions=None, model=None, model_options=None, voice=None, tools=None, interruption_sensitivity=None, greeting=None, audio=None, mcp=None, skills=None, hooks=None)` | Build a reusable inline `RealtimeAgent` — the persona (see [`RealtimeAgent`](#realtimeagent)), including its opening `greeting` and its `audio` pipeline (`AudioConfig`: `output`, `noise_cancellation`, `ambience`). `voice` is the voice id as a plain string, or a `VoiceConfig(name=..., speaking_style=...)`. `tools` is a list of `ClientTool` / typed server opt-ins (`WebSearchTool`, `ExamineImageTool`, `DetectObjectsTool`, `PointAtObjectTool`, `EndCallTool`); `mcp` / `skills` / `hooks` attach the concepts described in their sections below. Fields left `None` fall back to the server default — `audio.noise_cancellation` among them, which is off, so the agent hears the raw microphone signal. Pass `AudioConfig(noise_cancellation=True)` when the microphone will hear more than one voice; the isolated signal is also what turn-taking reads, so measure endpointing on your own audio before leaving it on |
| `catalog_agent(name, *, inputs=None, voice=None, tools=None, mcp=None, hooks=None)` | Build an `RealtimeAgent` that runs a workspace catalog agent by machine handle; the stored config runs verbatim. `inputs` fills the agent's declared input fields; `voice` (string or `VoiceConfig`) overrides the stored voice for this run only; `tools` / `mcp` add client-executed declarations. There are no other persona parameters — sending stored config with a catalog launch is a type error |
| `mint_token(external_user_id)` | Mint a short-lived end-user JWT (`-> MintedToken{jwt, expires_at}`). Requires an `api_key` credential; raises `MintTokenError` otherwise |
| `verify()` | Check the credential without starting a session (`-> CredentialInfo`). Free — see [Verifying a credential](#verifying-a-credential). Raises `VerifyError` if the credential is rejected |
| `aclose()` | Close the owned HTTP client (also an async context manager) |

### `RealtimeAgent`

A reusable persona built by `client.agent(...)`; one agent opens any number of
sessions.

| Member | Description |
|---|---|
| `start(*, resume_session_id=None, store_recording=None, on_state_change=None)` | Open a session: POST `session/start` (a `session-config` payload) + LiveKit join. These are the per-run, transport-level options (resume, recording opt-out, lifecycle observer); persona fields — including `greeting` and the `audio` pipeline — ride unchanged from the agent (build another agent to change them). Returns a `SessionHandle` that is an **async context manager** (`async with agent.start() as session:` — ends the session on exit) and is also awaitable (`session = await agent.start()` if you own the lifecycle). Raises `VersionMismatchError` when the server refuses the protocol version, `SessionStartError` for any other rejection |

### `RealtimeSession`

| Member | Description |
|---|---|
| `async for event in session` | The typed event stream (see above) |
| `send_text(content)` | Send a text turn the agent answers. For a session that never speaks, configure the agent with `audio=AudioConfig(output=False)` |
| `send_context(content)` | Give the agent context without asking it anything: no turn, no speech, no transcript entry. For live application state |
| `set_muted(muted)` | Toggle the server-side mic gate |
| `ping()` | Heartbeat; server replies with a `PongEvent` event |
| `send_activity_end()` | Manual end-of-turn (wake-word gating only) |
| `send_image(data=..., mime_type=..., stream_id=...)` | One base64 image frame |
| `end()` | Graceful end: `end` frame + finish the stream + leave the room |
| `close()` | Abrupt local teardown without telling the server |
| `set_microphone_enabled(enabled, *, capture=None)` | Capture + publish the default OS mic (or stop it), gating the server side. Capture runs in WebRTC's audio device module, so echo cancellation, noise suppression, and gain control are applied before the audio is sent; pass `MicrophoneCapture` to change which of the three run. See `voice_cli` in the [examples repo](https://github.com/socratic-ai/cosmo-ai/tree/main/examples/python) |
| `set_speaker_enabled(enabled)` | Play the agent's voice on the default OS output device (or stop it) (livekit-rtc Python has no native playback; the SDK supplies it via `sounddevice`). See `voice_cli` in the [examples repo](https://github.com/socratic-ai/cosmo-ai/tree/main/examples/python) |
| `set_agent_playback_volume(volume)` | Software gain 0…1 for OS playback (clamped; `0` mutes). Affects only `set_speaker_enabled` output, never `agent_audio()` frames; may be set before the speaker is enabled |
| `agent_audio()` | Async-iterate the agent's decoded voice as 16-bit mono PCM `AgentAudioFrame`s (`cosmo_ai.audio`) — record it, pipe it to telephony, or feed a custom player. Multiple concurrent iterators each get every frame; a stalled consumer drops its oldest. Finishes when the session ends |
| `audio_levels()` | Async-iterate `AudioLevels(mic, agent)` (`cosmo_ai.audio`) RMS levels (0…1) at ~20 Hz, latest-value. Iterating activates agent-audio decode; fields read `0.0` while their source is inactive |
| `start_audio_stream(source)` / `stop_audio_stream()` | Publish a caller-owned `rtc.AudioSource` as the session's voice and keep feeding it frames yourself — for audio the SDK cannot capture itself (synthetic generator, WAV replay, load tests, hosts with no input device). One voice per session: raises `AudioPublishAlreadyActiveError` while the microphone or another stream is publishing |
| `dial(phone_number)` | Place an outbound phone call into this session — the callee joins as a SIP participant (see [Outbound calling](#outbound-calling)) |
| `usage()` | Fetch this session's usage summary over REST (`-> SessionUsage`) — duration, talk time, and token counts — during the session or after it ends. `usage_status` reports whether the detailed summary is there — `PENDING` while it may still land, `RECORDED` once the numbers are final, `UNAVAILABLE` when none was written and none will be; `tokens` is `None` when the provider doesn't report token usage. Raises `UsageError`. `client.get_session_usage(session_id)` is the client-level form |
| `start_screen_share()` / `push_screen_share_frame(frame)` / `stop_screen_share()` | Screen-share publish |
| `add_video_stream()` / `handle.push(frame)` / `remove_video_stream(handle)` | Publish video that is **not** the user's screen — a camera, a file, any pixels-only source (see [Publishing video](#publishing-video)) |
| `state` / `session_id` / `connect_timings` / `config` | Lifecycle snapshot + start results. `connect_timings` carries the client-measured connect phases plus the server's own `server_timings` breakdown |

### Tools

Define a client-executed tool with the `@tool` decorator: the first
parameter's Pydantic model drives the model-facing JSON Schema, runtime
validation, and the typed arguments the handler receives.

```python
from typing import Any, Literal

from pydantic import BaseModel, Field

from cosmo_ai import WebSearchTool, tool


class WeatherInput(BaseModel):
    city: str = Field(description="City name")
    unit: Literal["c", "f"] = "c"


@tool  # or @tool(name=..., description=..., background=False)
async def get_weather(input: WeatherInput) -> dict[str, Any]:
    """Current weather for a city."""
    return {"temp_c": await lookup(input.city)}


agent = client.agent(
    tools=[get_weather, WebSearchTool()],
)
async with agent.start() as session:
    async for event in session:
        ...
```

- **Name** defaults to the function name, **description** to the docstring
  (both overridable via `@tool(name=..., description=...)`; the description is
  model-facing and required).
- **Everything checks at decoration**, not at connect: signature shape, name
  and description limits, and the emitted schema against the backend's
  restricted JSON-Schema dialect. A model whose schema the server would
  reject (regex `pattern`s, `format`s, recursive models, `extra="forbid"`, …)
  raises `ToolSchemaError` at import/startup instead of surfacing in
  `ReadyEvent.rejected_tools` mid-connect.
- **Malformed model calls never reach your code.** Arguments are validated
  with `Model.model_validate` first; a failure becomes a sanitized
  `INVALID_INPUT` tool error the model can self-correct from (paths +
  constraints only — submitted values never appear in the error or in logs).
- **Validation semantics are Pydantic's**: coercion applies, defaults are
  filled in. The emitted schema describes the accepted input; the handler
  receives the validator's output.
- **Long-running work**: `@tool(background=True)` expects
  `async def fn(input: Model, job: ClientToolJob)` and follows the unchanged
  job contract (`job.ack(...)`, then `job.complete(...)` / `job.fail(...)`).

The decorator lowers to a plain `ClientTool`, which stays public in
`cosmo_ai.tools` as the advanced escape hatch — hand-write one to
control the raw JSON Schema yourself (its handler then receives an
unvalidated `dict`):

```python
from cosmo_ai.tools import ClientTool

ClientTool(
    name="get_local_time",
    description="Returns the local wall-clock time.",
    parameters={"type": "object", "properties": {}, "required": []},
    handler=get_local_time,  # async (args: dict) -> dict
)
```

When the agent invokes a client tool the SDK calls the handler and reports
the returned dict back as the result; raise to surface a tool error. The
handler is local-only: it is excluded from serialization and never crosses
the wire. Every client tool carries a handler — constructing a spec without
one is a validation error, since a declared tool the client cannot execute
would fail on every invocation.

Typed opt-in classes enable built-in server-executed tools — `WebSearchTool`
(web search), `ExamineImageTool` (full-resolution frame examination),
`DetectObjectsTool` / `PointAtObjectTool` (object locators), `EndCallTool` (the agent
hangs up itself). Each is zero-config: the server
owns the model-facing declaration; you only opt in.

Client-tool specs the server refuses are echoed on
`ReadyEvent.rejected_tools`; the session still starts without them.

The `cosmo_sdk_` name prefix is **reserved for the client tools the SDK ships
itself** — the SDK owns their names and schemas, so a caller's tool taking one
would swap it for something the model was told behaves differently. A tool of
your own carrying the prefix is rejected where you declared it rather than at
connect (the wider `cosmo_` namespace belongs to server tools, which the server
rejects too); every other name stays free, including the natural ones the SDK's
own tools shorten to.

### Publishing video

`start_screen_share` publishes the user's screen. `add_video_stream` publishes
everything else — a camera, a decoded file, a rendered scene:

```python
from livekit import rtc

stream = await session.add_video_stream()
while capturing:
    pixels = grab_frame()                      # yours: OpenCV, picamera, a file
    stream.push(rtc.VideoFrame(width, height, rtc.VideoBufferType.RGB24, pixels))
await session.remove_video_stream(stream)
```

The two publish under different LiveKit sources, which is how the backend
tells them apart: a camera feed is described to the model as one, and the
screen tools stay anchored to actual screen shares. **One video publish at a
time** — a second `add_video_stream`, or a `start_screen_share` while a stream
is live, raises `VideoPublishAlreadyActiveError` (`from cosmo_ai import
VideoPublishAlreadyActiveError`).

`push` is safe to call from whatever thread your capture loop runs on; the
publish it triggers is handed to the session's event loop.

Capturing frames is yours. The SDK opens no camera and brings no dependency
for one; anything that can produce an `rtc.VideoFrame` works, and LiveKit
accepts the common buffer layouts (`RGB24`, `RGBA`, `BGRA`, `I420`, …) so
there is usually no conversion to write. The publish is deferred to the first
frame, so dimensions resolve from the source rather than from the arguments.

### Drawing on the user's live view

`draw_box` / `draw_point` are the renderer half of the locate-then-draw pair.
A locator (`DetectObjectsTool` / `PointAtObjectTool`) returns candidate boxes
or points to the model; the model picks the one matching what it is looking at
and passes it to the renderer, which draws it over the user's live camera or
screen preview. You supply one function of request → outcome; the SDK owns the
name, description, schema, decode, and reply shape.

```python
from cosmo_ai import DetectObjectsTool
from cosmo_ai.tools import DrawBoxRequest, DrawOutcome, draw_box


def on_draw(request: DrawBoxRequest) -> DrawOutcome:   # sync or async
    if not camera.streaming:
        return DrawOutcome(
            shown=False,
            reason="the camera is off — ask the user to turn it on",
        )
    overlay.show(request.box, label=request.label)
    return DrawOutcome(shown=True)


agent = client.agent(tools=[DetectObjectsTool(), draw_box(on_draw)])
```

- **Coordinates are normalized** to the frame the model was shown — `[0,1]`,
  top-left origin — so you map them onto the preview the same way you map a
  locator's box. Out-of-range values are clamped, so a model that overshoots
  the frame edge still yields a drawable annotation.
- **Malformed arguments never reach your handler**; they surface to the model
  as the invocation's error.
- **Answer honestly.** `DrawOutcome`'s `reason` is model-facing prose the agent
  says out loud, not an error code — a box reported as shown but invisible
  leaves the model talking about something the user cannot see.

`draw_point` follows the same contract with a `DrawPointRequest`. The two exist
side by side because they answer different questions: a box around a leaf
includes everything behind it, where a marked point says one thing.

### Locating on the shared screen

`screen_locate` turns on the server-side screen locator, and
`screen_click_element` / `screen_highlight_element` act on what it finds. The
locator resolves a natural-language description ("the Save button") to a specific
on-screen control and hands the model a `found_element` handle; the model passes
that handle back to a renderer, which resolves it to the element it addresses.
Unlike `DetectObjectsTool`, the locator needs a screen to look at, so declaring
it means supplying a `capture` handler:

```python
from cosmo_ai.tools import (
    ScreenCapture,
    ScreenClickOutcome,
    ScreenClickTarget,
    ScreenElement,
    screen_click_element,
    screen_locate,
)


def grab() -> ScreenCapture:                       # sync or async
    image_jpeg, controls = snapshot_and_walk_accessibility_tree()   # yours
    return ScreenCapture(
        image_jpeg=image_jpeg,
        elements=[
            ScreenElement(index=i, role=c.role, frame=c.frame, title=c.title)
            for i, c in enumerate(controls)
        ],
    )


def on_click(target: ScreenClickTarget) -> ScreenClickOutcome:   # sync or async
    if not can_control_the_desktop():
        return ScreenClickOutcome(clicked=False, reason="I need accessibility access")
    press(target.element.frame, target.action)     # left/right, single/double
    return ScreenClickOutcome(clicked=True)


agent = client.agent(tools=[screen_locate(grab), screen_click_element(on_click)])
```

- **`screen_locate` is never advertised.** The model cannot call it — the
  server's `cosmo_screen_locate` does, and the SDK answers its capture RPC from
  your `capture` handler. It reaches the wire as the bare `{kind:
  "screen_locate"}`; the handler is local-only and stays off the wire. Supplying
  it is the only way to turn the locator on — there is no hand-writable opt-in.
- **`capture` owns only the snapshot.** The SDK owns the cache that keeps each
  snapshot alive for the handles minted against it, the payload encoding, the
  byte-stream upload, and the ack. Raise from `capture` to decline benignly
  (the message reaches the model as "couldn't see the screen"); the SDK never
  inspects `ScreenCapture.context`, so stash per-capture state there to validate
  freshness at click time.
- **A stale handle declines, it doesn't act.** A handle the cache can no longer
  resolve returns `clicked=False` with a reason telling the model to locate
  again, rather than clicking a different control.
- **`screen_click_element` is server-gated.** Clicking acts on the user's
  machine, so it sits behind a desktop-control policy that defaults off: a
  session that cannot run it starts without it and echoes the drop on
  `ReadyEvent.rejected_tools` under `cosmo_sdk_screen_click_element`. A dropped
  renderer is simply never invoked. The locator and `screen_highlight_element`
  are ungated.

`screen_highlight_element` highlights an element without acting on it (same
`found_element` contract). `screen_highlight_box` is the default way to point at
something: the model gives a box as fractions of the surface and your handler
draws it directly — no capture, no lookup. Both highlights answer in the same
`ScreenHighlightOutcome(shown=True, exact=...)`, so the model learns whether the
highlight snapped onto a real control or only its estimate.

```python
from cosmo_ai.tools import (
    ScreenHighlightBoxRequest,
    ScreenHighlightOutcome,
    screen_highlight_box,
)


def on_box(request: ScreenHighlightBoxRequest) -> ScreenHighlightOutcome:
    landed = overlay.highlight(request.box, label=request.label)
    return ScreenHighlightOutcome(shown=True, exact=landed)


agent = client.agent(tools=[screen_highlight_box(on_box)])
```

If your app shows the frames it publishes, `box_rect` / `point_position`
(`cosmo_ai.tools`) put the annotation where the model pointed: they map a
normalized box or point onto the view showing the frame, correcting for the
crop or letterbox and for a mirrored selfie preview. Pure arithmetic, in
whatever coordinate space your preview uses — the SDK owns no window and draws
nothing.

```python
from cosmo_ai.tools import Size, box_rect

rect = box_rect(
    request.box,
    container=Size(view_width, view_height),
    frame_size=Size(frame_width, frame_height),
    content_mode="fill",
    mirrored=front_camera,
)
```

### Outbound calling

`session.dial(phone_number)` places an outbound phone call **into a running
session**: the dialed party joins the session's room as a SIP participant and
the agent — already in the room — converses with them. `start()` stays about
creating the session; choosing participants (the local mic, or a phone callee)
is always a separate, explicit step.

```python
async with agent.start() as session:        # session only — no participants yet
    await session.dial("+14155550199")        # bring the callee in over SIP
    async for event in session:               # transcripts, etc., as usual
        ...
```

- **Number format** — E.164 (`+` then 8–15 digits); the SDK fast-fails a
  malformed number with `DialError(code="invalid_phone_number")` before any
  request.
- **Enablement** — outbound calling must be enabled for the workspace
  (`phone_calls_disabled` otherwise); the same `realtime:use` credential that
  opened the session authorizes the dial.
- **Limits** — calls count against the workspace's weekly per-user minute limit.
- **Errors** — server rejections raise `DialError` with the server's slug
  (`phone_calls_disabled`, `minute_limit_exceeded`, `session_not_live`,
  `forbidden`, …).
- **Return** — `DialResult{dial_id}`, a handle to the queued call. The call
  rings asynchronously; watch `session` events for the conversation.

The call is a transport-level REST request (not a data-channel send), so it is
the one `RealtimeSession` method that reaches the API directly. See
`outbound_call.py` in the [examples repo](https://github.com/socratic-ai/cosmo-ai/tree/main/examples/python).

---

## MCP servers (local stdio)

Expose any local [MCP](https://modelcontextprotocol.io) server's tools to the
realtime model. Attach servers with the `mcp` argument — a Claude-Code
`.mcp.json` config file (one file describes many servers), or a list mixing
config files and inline `McpStdioServer` objects (a path element expands in
place). The SDK spawns each server at session start, lists its tools, and
proxies calls — tools are namespaced `mcp__<server>__<tool>`.

```python
from cosmo_ai import RealtimeClient

client = RealtimeClient(api_key="cosmo_...")
agent = client.agent(instructions="You are Alex.", mcp="./mcp.json")
```

```python
from cosmo_ai.mcp import McpStdioServer

agent = client.agent(
    instructions="You are Alex.",
    mcp=[McpStdioServer(name="fs", command="npx", args=("-y", "@modelcontextprotocol/server-filesystem", "/tmp"))],
)
```

A missing or malformed config file and duplicate server names raise
`McpConfigError` when the agent is built, not mid-call. Requires the `mcp`
extra: `pip install 'cosmo-ai-sdk[mcp]'` (a live connect without it raises
`McpExtraNotInstalledError`). v1 supports **stdio** servers; remote (`http`/`sse`)
entries in `.mcp.json` are skipped with a warning so the file stays shareable
with harnesses that support them. An `McpStdioServer` runs an arbitrary local
command — trust your config.

---

## Hooks

Attach in-process callbacks at the session's four lifecycle seams —
`SessionStart`, `PreToolUse`, `PostToolUse`, `SessionEnd`. Observe
everything; override the two seams
the client controls (inject start-of-session context; deny or rewrite a local
client-tool call).

Declare a hook with the seam's decorator — the decorated name becomes a
`Hook` — and attach with `hooks=[...]`; list order is fold order:

```python
from cosmo_ai import RealtimeClient, hooks
from cosmo_ai.hooks import PreToolUseResult

@hooks.pre_tool_use(matcher="delete_*")
def block_deletes(ctx) -> PreToolUseResult:
    return PreToolUseResult(permission="deny", reason="destructive tools are disabled")

@hooks.session_end
async def log_end(ctx) -> None:
    print("session ended:", ctx.reason.value)

client = RealtimeClient(api_key="cosmo_...")
agent = client.agent(instructions="You are Alex.", hooks=[block_deletes, log_end])
```

The same list also carries **server hooks** — declarative rules the server
executes (they work even if your process dies mid-call): `SilenceTimeout` with
a `Say` or `EndCall` action, e.g.
`hooks=[log_end, SilenceTimeout(timeout_seconds=45, action=EndCall())]`.
A fired server hook reaches you as a `UserSpeechTimeoutEvent` event on the
session's event stream, not as a hook.

A throwing hook is logged and skipped — it never breaks the session. A
malformed matcher raises at decoration, not at session start. `SessionStart`
`additional_context` is appended to the instructions; `PreToolUse`
`deny`/`updated_arguments` apply only to locally-executed client tools.

See `hooks_agent.py` in the [examples repo](https://github.com/socratic-ai/cosmo-ai/tree/main/examples/python) for a runnable end-to-end example.

---

## Package layout

| Module | Contents |
|---|---|
| `cosmo_ai.client` | `RealtimeClient`, `SessionHandle` (the return of `RealtimeAgent.start`; both re-exported at the root) |
| `cosmo_ai.session` | `RealtimeSession`, `RealtimeSessionState`, `DisconnectReason` |
| `cosmo_ai.audio` | `AgentAudioFrame`, `AudioLevels`, `AGENT_AUDIO_SAMPLE_RATE` — the payload types you consume from `agent_audio()` / `audio_levels()` |
| `cosmo_ai.tools` | `tool` (also re-exported at the root), the renderer tools the SDK ships — the draw pair (`draw_box`, `draw_point`, `DrawBoxRequest`, `DrawPointRequest`, `DrawOutcome`, `NormalizedBox`, `NormalizedPoint`) and the screen tools (`screen_locate`, `screen_click_element`, `screen_highlight_element`, `screen_highlight_box`, with `ScreenCapture`, `ScreenElement`, `ScreenClickTarget`, `ScreenClickOutcome`, `ScreenHighlightTarget`, `ScreenBox`, `ScreenHighlightBoxRequest`, `ScreenHighlightOutcome`) — plus advanced authoring: `ClientTool`, `BackgroundClientTool`, `ClientToolJob`, `ToolSchemaError`, `ToolInputValidationError` |
| `cosmo_ai.skills` | `Skill`, `SkillParseError`, `SkillsInput` — the `skills=` argument takes a directory or a `Sequence[Skill]` |
| `cosmo_ai.mcp` | `McpStdioServer`, `McpConfigError`, `McpExtraNotInstalledError`, `McpInput` — the `mcp=` argument takes a `.mcp.json` path or a list of servers |
| `cosmo_ai.hooks` | the four seam decorators (`@hooks.session_start`, `@hooks.pre_tool_use(matcher=…)`, …), `Hook`, the context/result types, the `ToolOk`/`ToolError`/`ToolDenied` outcomes, and the server hooks (`SilenceTimeout`, `Say`, `EndCall`) |
| `cosmo_ai.errors` | `RealtimeError` (the base every SDK error extends), `SessionStartError`, `VersionMismatchError`, `MintTokenError`, `VerifyError`, `DialError`, `NotConnectedError`, `VideoPublishAlreadyActiveError`, `ToolSchemaError`, `ToolInputValidationError`, `AudioUnavailableError`, `ExtraNotInstalledError` (the `mcp` extra; see `McpExtraNotInstalledError`) |

The wire models (internal, `_internal/protocol.py`) are hand-written Pydantic
mirrors of the published OpenAPI spec and are kept pinned to it, so drift
fails loudly.

---

## Skills

Decompose a long system prompt into just-in-time **skills**. Each skill is a
`SKILL.md` (name + description + body, the Agent Skills standard); only the
names/descriptions ride in the prompt, and the body loads on demand via a
single `cosmo_sdk_load_skill` tool. A loaded body stays in context for the
rest of the call and counts toward the prompt every turn, so keep bodies
tight (split long walkthroughs into small skills).

Attach skills with the `skills` argument — a directory, or a list mixing
directories and inline `Skill` objects (a path element expands in place, so
built-in skills can layer with a user folder:
`skills=[*BUILTINS, "./user-skills"]`; duplicate names raise):

```python
from cosmo_ai import RealtimeClient

client = RealtimeClient(api_key="cosmo_...")
agent = client.agent(instructions="You are Alex.", skills="./skills")
```

```python
from cosmo_ai.skills import Skill

agent = client.agent(
    instructions="You are Alex.",
    skills=[Skill(name="activate-card", description="...", body="...")],
)
```

Skill files live in `./skills/<name>/SKILL.md`:

```markdown
---
name: activate-card
description: Walk the customer through activating their card.
---
Acknowledge they want to activate. Ask web or app, then one step at a time.
```

Directory semantics: a directory that itself contains a `SKILL.md` is that one
skill; otherwise each `<child>/SKILL.md` is a skill. A directory yielding no
skills logs a warning and attaches none (an empty per-user skills folder is a
valid state); a missing path or malformed SKILL.md raises `SkillParseError`
when the agent is built, not mid-call. Unknown frontmatter keys (`tier`,
`allowed-tools`, `license`, …) are ignored, so files authored for other
harnesses stay valid.

---

## Development

```bash
pip install -e ".[dev]"
ruff check src/
mypy src/
pytest
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
