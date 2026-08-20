"""External realtime wire protocol — typed models for the published SDK surface.

Hand-written Pydantic mirrors of the external protocol's component schemas
(the published realtime OpenAPI spec, exported from the backend wire models). Drift between these
models and the spec fails a CI pin test.

Forward compatibility: a server frame with an unrecognized ``type`` (or a
recognized type that fails validation) surfaces as :class:`UnknownEvent` and
the session stays alive — decode failures are never terminal.
"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable
from datetime import datetime
from enum import Enum
from importlib import metadata
from typing import TYPE_CHECKING, Annotated, Any, Literal, Union
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.json_schema import SkipJsonSchema

if TYPE_CHECKING:
    from cosmo_ai.tools._jobs import ClientToolJob


SDK_NAME = "cosmo-ai-sdk"


def _sdk_version() -> str:
    try:
        return metadata.version(SDK_NAME)
    except metadata.PackageNotFoundError:
        return "0.0.0"


SDK_VERSION = _sdk_version()

_INSTRUCTIONS_MAX_LEN = 16384
_SPEAKING_STYLE_MAX_LEN = 8192
_VOICE_MAX_LEN = 128
_TOOL_SPECS_MAX_COUNT = 64
_CLIENT_TOOL_MAX_NAME_LEN = 64
_CLIENT_TOOL_MAX_DESCRIPTION_LEN = 2048
_SERVER_HOOKS_MAX_COUNT = 16
_SERVER_HOOK_TEXT_MAX_LEN = 4096
_SERVER_HOOK_NAME_MAX_LEN = 256
_CONTEXT_NOTE_MAX_CHARS = 4096


def _new_message_id() -> str:
    """Per-message UUID4 hex — for log correlation + transport-level dedupe."""
    return uuid.uuid4().hex


# ─────────────────────────────────────────────────────────────────────────────
# Shared
# ─────────────────────────────────────────────────────────────────────────────


class TranscriptRole(str, Enum):
    """Speaker for a transcript fragment.

    Members are lowercase so ``event.role == "assistant"`` reads the way
    Python developers expect, matching the other Cosmo SDKs' developer-facing
    surface. The wire spells these ``"USER"`` / ``"ASSISTANT"``; decoding
    accepts either casing, so the wire form never reaches user code.
    """

    USER = "user"
    ASSISTANT = "assistant"

    @classmethod
    def _missing_(cls, value: object) -> "TranscriptRole | None":
        if isinstance(value, str):
            lowered = value.lower()
            for member in cls:
                if member.value == lowered:
                    return member
        return None


class ErrorCode(str, Enum):
    """Stable error codes clients switch on to choose a recovery UX."""

    AUTH_FAILED = "auth_failed"
    WORKSPACE_FORBIDDEN = "workspace_forbidden"
    VOICE_DISABLED = "voice_disabled"
    UPSTREAM_DISCONNECT = "upstream_disconnect"
    INTERNAL_ERROR = "internal_error"
    INVALID_MESSAGE = "invalid_message"
    VERSION_MISMATCH = "version_mismatch"


class InterruptionSensitivity(str, Enum):
    """How readily user audio barges in over the assistant."""

    DEFAULT = "default"
    HIGH = "high"
    LOW = "low"


class AmbienceTrack(str, Enum):
    """Server-allowlisted ambience bed the client may request on its OUTPUT
    audio. A NAME, never a filesystem path — the server resolves it."""

    OFFICE = "office"


class ThinkingLevel(str, Enum):
    """Reasoning depth the client may request for the Gemini realtime model."""

    MINIMAL = "minimal"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class EndOfSpeechSensitivity(str, Enum):
    """How readily the Gemini realtime model decides the user's turn ended —
    the end-of-turn counterpart to ``InterruptionSensitivity``'s speech-start
    gate. ``high`` endpoints sooner, so the assistant answers faster."""

    LOW = "low"
    HIGH = "high"


class TurnDetectionMode(str, Enum):
    """Which turn detector ends the user's turn. ``server_vad`` ends the turn
    on a fixed silence window; ``semantic_vad`` (OpenAI) ends it as soon as
    the utterance reads as complete; ``cosmo_vad`` (Gemini) runs Cosmo's own
    semantic detector server-side."""

    SERVER_VAD = "server_vad"
    SEMANTIC_VAD = "semantic_vad"
    COSMO_VAD = "cosmo_vad"


class SemanticEagerness(str, Enum):
    """How eagerly OpenAI's ``semantic_vad`` closes the user's turn. ``low``
    waits longer for the user to continue, ``high`` responds sooner; ``auto``
    behaves like ``medium``."""

    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    AUTO = "auto"


# ─────────────────────────────────────────────────────────────────────────────
# Tool specs (session-config payload)
# ─────────────────────────────────────────────────────────────────────────────


ClientToolHandler = Callable[[dict[str, Any]], Awaitable[dict[str, Any] | None]]
"""An async client-tool handler: ``async (args) -> result``. ``args`` is the
decoded tool-call arguments; the returned dict is reported back to the agent as
the tool result. A handler may return ``None`` for an empty (``null``) result —
the reply envelope's ``result`` slot is ``object | null``. Raise to surface a
tool error. The handler is local-only — it is excluded from serialization and
never crosses the wire."""


BackgroundClientToolHandler = Callable[
    [dict[str, Any], "ClientToolJob"], Awaitable[None]
]
"""An async background client-tool handler: ``async (args, job) -> None``. Used by
:class:`BackgroundClientTool` for work that outlives the voice turn — ack the call
with ``await job.ack(note)`` (releasing the reply while the handler keeps running),
then deliver the result later with ``job.complete(...)`` / ``job.fail(...)``."""


class ClientTool(BaseModel):
    """One client-executed tool, self-described at session start.

    The server materializes a session-scoped tool definition from each spec.
    ``parameters`` is a JSON Schema for the tool's arguments (restricted
    dialect, top-level ``type: "object"``). Specs the server refuses are
    echoed on ``ReadyEvent.rejected_tools`` and the session starts
    without them.

    ``handler`` executes the tool: when the agent invokes it, the SDK calls
    ``await handler(args)`` and reports the returned dict back as the result.
    Every client tool carries one — a declared tool the client cannot execute
    would fail on every invocation, so constructing a spec without a handler
    is a validation error. The handler is local-only — it is excluded from
    serialization and never crosses the wire.
    """

    model_config = ConfigDict(arbitrary_types_allowed=True)

    kind: Literal["client"] = "client"
    name: str = Field(max_length=_CLIENT_TOOL_MAX_NAME_LEN)
    description: str = Field(max_length=_CLIENT_TOOL_MAX_DESCRIPTION_LEN)
    parameters: dict[str, Any]
    handler: SkipJsonSchema[ClientToolHandler] = Field(exclude=True)


class BackgroundClientTool(ClientTool):
    """A client-executed tool whose work runs in the background.

    Declared and sent identically to :class:`ClientTool` — the background
    behavior is entirely client-side. Its ``handler`` receives a
    :class:`ClientToolJob`: it acks the call immediately (``job.ack``) so the
    session isn't blocked, then delivers the result later (``job.complete`` /
    ``job.fail``). Use it for a tool whose execution can outlast the voice
    turn (an export, a scan, a wait for user input).
    """

    # Concrete (no forward ref) so Pydantic can build the model; the public
    # contract is the ``BackgroundClientToolHandler`` alias.
    handler: SkipJsonSchema[Callable[..., Awaitable[None]]] = Field(exclude=True)


class WebSearchTool(BaseModel):
    """Opt-in to the server-executed web-search tool. The server owns the
    model-facing declaration — zero-config; unknown fields are a validation
    error. Server tools execute server-side; the session observes them
    through the ``tool-call`` / ``tool-dispatch-started`` / ``tool-result``
    lifecycle."""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["web_search"] = "web_search"


class ExamineImageTool(BaseModel):
    """Opt-in to the server-executed frame-examination tool: reads the
    freshest frame of the published video at full resolution to answer a
    fine-detail question. Zero-config; unknown fields are a validation
    error."""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["examine_image"] = "examine_image"


class DetectObjectsTool(BaseModel):
    """Opt-in to the server-executed object locator that returns boxes —
    one per matching instance. Zero-config; unknown fields are a
    validation error."""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["detect_objects"] = "detect_objects"


class PointAtObjectTool(BaseModel):
    """Opt-in to the server-executed object locator that returns points.
    Zero-config; unknown fields are a validation error."""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["point_at_object"] = "point_at_object"


class EndCallTool(BaseModel):
    """Opt-in to the server-executed hang-up, so the agent can end the call
    itself. Zero-config; unknown fields are a validation error. Ending binds
    the call, not just the agent — every leg drops — and the spoken goodbye
    is allowed to finish first.

    Not :class:`EndCall`, which is what a silence hook does when it fires.
    """

    model_config = ConfigDict(extra="forbid")

    kind: Literal["end_call"] = "end_call"


ScreenCaptureHandler = Callable[..., Any]
"""The host's screen-capture callback, taking a capture request or nothing at
all. Loosely typed at the protocol layer to
keep the screen dataclasses out of the wire models; the precisely-typed public
alias lives in :mod:`cosmo_ai.tools._screen_types`, and the
:func:`~cosmo_ai.tools.screen_locate` factory that enforces it in
:mod:`cosmo_ai.tools._screen`."""


class ScreenLocateTool(BaseModel):
    """Opt-in to the server-executed screen locator.

    Resolves a description to an element on the client's shared screen and
    hands the model a ``found_element`` handle addressing it, which the model
    passes to whichever screen renderer the client declared
    (``cosmo_sdk_screen_click_element`` / ``cosmo_sdk_screen_highlight_element``).
    Not authorable as a bare kind: the SDK emits ``{kind: "screen_locate"}``
    mechanically when the host supplies a ``capture`` handler, whose
    ``screen_capture`` RPC the locator drives.

    ``capture`` executes the capture: the locator RPCs the client, the SDK
    calls ``await capture()``, and publishes the snapshot over a byte stream.
    Every screen-locate spec carries one — the locator cannot ground without
    a screen to look at — so it has no default. Local-only: excluded from
    serialization, it never crosses the wire, and the spec reaches the server
    as the bare ``{kind: "screen_locate"}``.

    The locator itself has no availability gate. ``cosmo_sdk_screen_click_element``
    does — clicking acts on the user's machine, so a session that cannot run
    it starts without it and reports the drop on ``ready.rejected_tools``
    under that name.
    """

    model_config = ConfigDict(arbitrary_types_allowed=True)

    kind: Literal["screen_locate"] = "screen_locate"
    capture: SkipJsonSchema[ScreenCaptureHandler] = Field(exclude=True)


RealtimeToolSpec = Annotated[
    Union[
        ClientTool,
        WebSearchTool,
        ExamineImageTool,
        DetectObjectsTool,
        PointAtObjectTool,
        EndCallTool,
        ScreenLocateTool,
    ],
    Field(discriminator="kind"),
]

AgentTool = (
    ClientTool
    | WebSearchTool
    | ExamineImageTool
    | DetectObjectsTool
    | PointAtObjectTool
    | EndCallTool
    | ScreenLocateTool
)
"""Plain union of the authorable tool classes — the ``tools=`` parameter
type on client/agent signatures (:data:`RealtimeToolSpec` is its
discriminated wire twin)."""


# ─────────────────────────────────────────────────────────────────────────────
# Client → server
# ─────────────────────────────────────────────────────────────────────────────


class ExperimentalParams(BaseModel):
    """Unstable session-config knobs nested under
    ``SessionConfig.session.experimental``. Fields here may change
    shape or disappear between releases; stable equivalents graduate to
    fields on the agent or session config."""

    resume_session_id: UUID | None = None
    """When set, the server resumes the named prior session."""


class Say(BaseModel):
    """Idle-message action: `text` = exact words, `prompt` = model-generated,
    both unset = free model speech."""

    type: Literal["say"] = "say"
    text: str | None = Field(default=None, max_length=_SERVER_HOOK_TEXT_MAX_LEN)
    prompt: str | None = Field(default=None, max_length=_SERVER_HOOK_TEXT_MAX_LEN)

    @model_validator(mode="after")
    def _at_most_one(self) -> "Say":
        if self.text is not None and self.prompt is not None:
            raise ValueError("Say takes at most one of text / prompt")
        return self


class EndCall(BaseModel):
    type: Literal["end_call"] = "end_call"
    farewell: str | None = Field(default=None, max_length=_SERVER_HOOK_TEXT_MAX_LEN)


ServerHookAction = Annotated[Union[Say, EndCall], Field(discriminator="type")]


class SilenceTimeout(BaseModel):
    """Server-hook config: perform `action` after `timeout_seconds` of
    user silence. See the design doc — no client behavior; wire config only."""

    trigger: Literal["user.speech.timeout"] = "user.speech.timeout"
    timeout_seconds: float = Field(ge=1, le=1000)
    action: ServerHookAction
    max_count: int = Field(default=3, ge=1, le=10)
    reset_mode: Literal["never", "on_user_speech"] = "never"
    name: str | None = Field(default=None, max_length=_SERVER_HOOK_NAME_MAX_LEN)


ServerHook = SilenceTimeout
"""Every server-hook kind. One kind today; becomes a ``|`` union discriminated
on ``trigger`` when a second lands — signatures and ``isinstance`` checks
against this name keep working either way."""


class VoiceConfig(BaseModel):
    """How the agent sounds: the prebuilt voice and the per-run speaking
    style. One sub-object shared by both agent variants."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, max_length=_VOICE_MAX_LEN)
    """Provider-specific prebuilt voice id. ``None`` lets the upstream pick
    per session."""
    speaking_style: str | None = Field(default=None, max_length=_SPEAKING_STYLE_MAX_LEN)
    """Caller-supplied "how to speak" instruction text, appended to the system
    prompt as its own section after the persona. ``None`` = none."""


class AmbienceConfig(BaseModel):
    """Background-ambience bed mixed into the assistant's OUTPUT audio.
    Presence of this object enables the bed; omit it for none."""

    model_config = ConfigDict(extra="forbid")

    track: AmbienceTrack | None = None
    """Named ambience bed to play; ``None`` uses the default bed."""
    gain_db: float | None = Field(default=None, ge=-60.0, le=0.0)
    """Ambience bed level relative to full scale (dB); sits under speech.
    ``None`` stays off the wire and keeps the server default."""


class AudioConfig(BaseModel):
    """The agent's audio pipeline, configured once — not per run."""

    model_config = ConfigDict(extra="forbid")

    output: bool | None = None
    """Whether the agent emits audio. ``False`` runs the session text-only:
    no speech reaches the room while input transcription and text output are
    unaffected — for transcription, captioning, or text-response apps.
    Rejected at session start when the resolved model cannot run text-only
    (self-contained speech-to-speech providers). ``None`` stays off the wire
    and keeps the server default (on). This is the only way to run a session
    without speech; there is no per-turn equivalent.

    Silence is guaranteed; skipping the work behind it is not. Only providers
    that can be asked for a text-only modality drop the synthesis — elsewhere
    speech is generated and discarded, so :class:`UsageEvent` can still
    report ``output_audio_tokens`` for a session nobody hears."""
    noise_cancellation: bool | None = None
    """Apply background-voice cancellation to the user's inbound audio.
    ``None`` stays off the wire and keeps the server default (on)."""
    ambience: AmbienceConfig | None = None
    """Background-ambience bed on the assistant's output; present = enabled,
    ``None`` = no bed."""


class CatalogAgentConfig(BaseModel):
    """Run a workspace catalog agent by machine handle — the stored config
    runs verbatim. Only per-run ride-alongs may accompany the launch;
    other stored-config fields are structurally absent from this variant, so
    the illegal combination is unrepresentable."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["catalog"] = "catalog"
    name: str = Field(
        max_length=100,
        pattern=r"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$",
    )
    """Machine handle of the workspace catalog agent to run. The server
    resolves it fail-closed at session start."""
    inputs: dict[str, str] | None = None
    """Per-run values for the referenced agent's declared input fields,
    substituted into the resolved prompt's ``{{key}}`` placeholders."""
    tools: list[RealtimeToolSpec] | None = Field(
        default=None, max_length=_TOOL_SPECS_MAX_COUNT
    )
    """Tool set for the session: :class:`ClientTool` specs the SDK fulfils
    locally, plus typed server-tool opt-ins (:class:`WebSearchTool`, …).
    Used verbatim — the stored agent config carries no tools, so nothing
    is merged in. ``None`` / empty runs the session with no tools."""
    voice: VoiceConfig | None = None
    """Per-run voice for the referenced agent: ``speaking_style`` is per-run
    text, and ``name`` is the one cosmetic exception to "the stored config
    runs verbatim" — it changes how the agent sounds, never what it says or
    can do. ``None`` keeps the stored voice."""


class CosmoVadConfig(BaseModel):
    """Tuning for the ``cosmo_vad`` turn detector. Every knob names the
    detector's own machinery, so a caller always knows which endpointer a
    setting touches; an unset knob keeps the server default."""

    model_config = ConfigDict(extra="forbid")

    pause_ms: int | None = Field(default=None, ge=0, le=5000)
    """Silence, in milliseconds, that triggers the end-of-turn inference."""
    prefix_ms: int | None = Field(default=None, ge=0, le=5000)
    """Audio, in milliseconds, kept from before speech was detected, so a
    turn's opening syllable is not clipped."""
    max_hold_ms: int | None = Field(default=None, ge=0, le=5000)
    """Total silence, in milliseconds, after which the turn ends regardless
    of the classifier's verdict."""


class GeminiModelOptions(BaseModel):
    """Gemini-realtime model knobs. Valid only when ``model`` runs on Gemini;
    the ``provider`` discriminator makes setting these for another provider a
    schema error, not a silent no-op.

    ``turn_detection`` selects which detector ends the user's turn, and each
    detector owns its knobs: ``end_of_speech_sensitivity``,
    ``silence_duration_ms`` and ``prefix_padding_ms`` tune the provider's
    ``server_vad``; the ``cosmo_vad`` block tunes ``cosmo_vad``. Naming a
    detector and sending the other one's knobs is rejected at session
    start."""

    model_config = ConfigDict(extra="forbid")

    provider: Literal["gemini"] = "gemini"
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    max_output_tokens: int | None = Field(default=None, ge=1, le=32768)
    thinking_level: ThinkingLevel | None = None
    include_thoughts: bool | None = None
    """Whether the model streams thought summaries alongside its answer. Only
    worth enabling for an app that reads them."""
    turn_detection: TurnDetectionMode | None = None
    """Which end-of-turn detector runs. ``cosmo_vad`` opts the session into
    Cosmo's semantic turn detection, which classifies whether the utterance
    reads as finished instead of timing a silence window. ``server_vad``
    pins the provider's silence-window detection, which the three knobs
    below tune; they are unread under ``cosmo_vad``. ``None`` keeps the
    server default (currently ``server_vad``). ``semantic_vad`` is
    OpenAI-only and rejected."""
    end_of_speech_sensitivity: EndOfSpeechSensitivity | None = None
    """How readily the model decides the user's turn ended. ``high`` endpoints
    sooner, so the assistant answers faster but is more likely to cut in on a
    mid-thought pause. Read only with ``server_vad``."""
    silence_duration_ms: int | None = Field(default=None, ge=0, le=5000)
    """Silence, in milliseconds, that ends the user's turn. Read only with
    ``server_vad``."""
    prefix_padding_ms: int | None = Field(default=None, ge=0, le=5000)
    """Audio, in milliseconds, kept from before speech was detected. Read
    only with ``server_vad``."""
    cosmo_vad: CosmoVadConfig | None = None
    """Tuning for the ``cosmo_vad`` detector. Sending it alongside
    ``server_vad`` is rejected. ``None`` keeps the server defaults."""


class OpenAIModelOptions(BaseModel):
    """OpenAI-Realtime model knobs. OpenAI Realtime pins its own sampling and
    token limits, so only turn-taking is tunable here.

    ``turn_detection`` decides which of the remaining knobs apply:
    ``eagerness`` belongs to ``semantic_vad``, the two window knobs to
    ``server_vad``. Sending a knob from the other mode is rejected at session
    start rather than silently ignored."""

    model_config = ConfigDict(extra="forbid")

    provider: Literal["openai"] = "openai"
    turn_detection: TurnDetectionMode | None = None
    """Which turn detector runs. ``None`` keeps the provider default
    (``server_vad``)."""
    eagerness: SemanticEagerness | None = None
    """How eagerly ``semantic_vad`` closes the user's turn. Valid only with
    ``turn_detection`` set to ``semantic_vad``."""
    silence_duration_ms: int | None = Field(default=None, ge=0, le=5000)
    """Silence, in milliseconds, that ends the user's turn. Valid only with
    ``server_vad``."""
    prefix_padding_ms: int | None = Field(default=None, ge=0, le=5000)
    """Audio, in milliseconds, kept from before speech was detected. Valid
    only with ``server_vad``."""


class OpenAIMiniModelOptions(BaseModel):
    """OpenAI-Realtime mini-tier model knobs — the same API on a faster,
    cheaper model, and equally untunable today."""

    model_config = ConfigDict(extra="forbid")

    provider: Literal["openai_mini"] = "openai_mini"


class GrokModelOptions(BaseModel):
    """xAI Grok Voice model knobs. Grok pins its own sampling and token
    limits, so only turn-taking is tunable here.

    Grok runs one detector — a fixed silence window — so the two knobs below
    always apply. Naming any other detector is rejected at session start."""

    model_config = ConfigDict(extra="forbid")

    provider: Literal["grok"] = "grok"
    turn_detection: TurnDetectionMode | None = None
    """Which turn detector runs. ``"server_vad"`` is the only one Grok offers,
    and ``None`` selects it."""
    silence_duration_ms: int | None = Field(default=None, ge=0, le=5000)
    """Silence, in milliseconds, that ends the user's turn."""
    prefix_padding_ms: int | None = Field(default=None, ge=0, le=5000)
    """Audio, in milliseconds, kept from before speech was detected."""


RealtimeModelOptions = Annotated[
    Union[
        GeminiModelOptions,
        OpenAIModelOptions,
        OpenAIMiniModelOptions,
        GrokModelOptions,
    ],
    Field(discriminator="provider"),
]
"""Provider-scoped model knobs, discriminated on ``provider``. Each knob is
honored only by its provider — ``thinking_level`` lives only on the Gemini
block — so an illegal pairing is unrepresentable. ``model`` selects the
concrete model within the chosen provider."""


class InlineAgentConfig(BaseModel):
    """Define the agent inline — the persona/configuration of the model on
    the other end, independent of any one run. Reused unchanged across
    sessions. Catalog-only fields (``name``, ``inputs``) are structurally
    absent from this variant."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["inline"] = "inline"
    instructions: str | None = Field(default=None, max_length=_INSTRUCTIONS_MAX_LEN)
    """Caller-supplied system instructions. Replaces the server's neutral
    default when set; ``None`` keeps the default."""
    model: str | None = None
    """Concrete model to run, within the provider named by ``model_options``.
    ``None`` lets the server choose its default; unavailable values are
    rejected explicitly at session start."""
    model_options: RealtimeModelOptions | None = None
    """Provider-scoped model knobs (sampling, reasoning depth, turn-taking),
    discriminated on ``provider``. Each knob is honored only by its provider,
    so the wire cannot express an illegal pairing. ``None`` keeps every
    provider default."""
    voice: VoiceConfig | None = None
    """How the agent sounds — prebuilt voice id and speaking style. ``None``
    keeps the server defaults for both."""
    audio: AudioConfig | None = None
    """The agent's audio pipeline — output emission, inbound noise
    cancellation, and the ambience bed. ``None`` keeps every server
    default."""
    greeting: str | None = Field(default=None, max_length=4000)
    """Opening line the assistant speaks first, voiced as soon as the model
    session opens. Part of the persona: what this agent says to open a call.
    ``None`` keeps the wait-for-user behavior."""
    tools: list[RealtimeToolSpec] | None = Field(
        default=None, max_length=_TOOL_SPECS_MAX_COUNT
    )
    """Tool set for the session: :class:`ClientTool` specs the SDK fulfils
    locally, plus typed server-tool opt-ins (:class:`WebSearchTool`, …).
    ``None`` / empty → no tools."""
    interruption_sensitivity: InterruptionSensitivity | None = None
    """How readily user audio barges in over the assistant. ``None`` stays off
    the wire and keeps the server default."""
    hooks: list[ServerHook] | None = Field(
        default=None, max_length=_SERVER_HOOKS_MAX_COUNT
    )
    """Server hooks (wire config; the server executes them). The only hooks
    that exist on the wire — client-side callback hooks never serialize."""


RealtimeAgentConfig = Annotated[
    Union[CatalogAgentConfig, InlineAgentConfig],
    Field(discriminator="type"),
]
"""The ``agent`` block of a session-config: launch a workspace catalog
agent by handle, or define one inline — discriminated on ``type``."""


class SessionParams(BaseModel):
    """Per-run, transport-level options for one session — continuity and other
    knobs that vary run-to-run for the same agent. Audio config lives on the
    ``agent`` block."""

    max_session_seconds: int | None = Field(default=None, ge=60, le=14400)
    """Requested wall-clock cap on the session, in seconds. The server resolves
    the effective cap as the minimum of this and its own limits — callers can
    only shorten, never extend. The effective value is echoed on
    :class:`ReadyEvent`."""
    store_recording: bool | None = None
    """Persist this session's recording artifacts (audio/video/transcript/tool
    events) server-side. ``False`` writes nothing for the run; ``None`` stays
    off the wire and stores as much as the account's consents allow. The
    per-artifact fields below win over this one."""
    store_audio: bool | None = None
    """Persist this session's audio. Narrowing only: a session may request
    less storage than the account permits, never more. ``None`` defers to
    ``store_recording``, then to those consents."""
    store_transcript: bool | None = None
    """Persist this session's transcript and tool-call events. Same contract
    as ``store_audio``."""
    store_video: bool | None = None
    """Persist this session's screen-share video. Same contract as
    ``store_audio``, except that it has no ``store_recording`` fallback."""
    experimental: ExperimentalParams | None = None
    """Opt-in unstable knobs (see :class:`ExperimentalParams`)."""


class SdkInfo(BaseModel):
    """Self-reported SDK identity stamped on ``session-config`` — which SDK
    and which package version opened the session."""

    name: str
    version: str


def _sdk_info() -> SdkInfo:
    return SdkInfo(name=SDK_NAME, version=SDK_VERSION)


class SessionConfig(BaseModel):
    """Session-start payload — the body of POST
    ``/api/v1/external/realtime/session/start``. Split into ``agent`` (the
    persona) and ``session`` (per-run transport options). The server replies
    with the join credentials, then ``ReadyEvent`` arrives on the data channel once the
    agent is up.
    """

    type: Literal["session-config"] = "session-config"
    id: str = Field(default_factory=_new_message_id)
    sdk: SdkInfo = Field(default_factory=_sdk_info)
    agent: RealtimeAgentConfig = Field(default_factory=InlineAgentConfig)
    session: SessionParams = Field(default_factory=SessionParams)


class ClientMute(BaseModel):
    """Toggle the mic gate. While muted the client drops outbound audio frames."""

    type: Literal["mute"] = "mute"
    id: str = Field(default_factory=_new_message_id)
    muted: bool


class ClientEnd(BaseModel):
    """User ended the session. Server tears down the upstream session and closes."""

    type: Literal["end"] = "end"
    id: str = Field(default_factory=_new_message_id)


class ClientPing(BaseModel):
    """Heartbeat. Server replies with ``PongEvent``."""

    type: Literal["ping"] = "ping"
    id: str = Field(default_factory=_new_message_id)


class ClientBindInput(BaseModel):
    """Bind the agent's audio input to this client.

    Sent after the client publishes its own audio (the human voice) so the
    agent listens to *this* participant. The server binds to the sender's
    participant identity — a client can only bind its own input — and the pin is
    sticky thereafter. A client that joins only to receive events or serve
    client tools, publishing no audio, never sends this and so is never the
    voice."""

    type: Literal["bind-input"] = "bind-input"
    id: str = Field(default_factory=_new_message_id)


class ClientText(BaseModel):
    """Send a text message instead of audio."""

    type: Literal["send-text"] = "send-text"
    id: str = Field(default_factory=_new_message_id)
    content: str


class ClientContext(BaseModel):
    """Add text to the model's context without asking it to reply.

    The content rides the provider's pre-turn channel, so the model is never
    asked for a response and cannot open a turn for it; it reads the note as
    background when it next answers. The opposite of ``send-text``, which
    *is* a turn."""

    type: Literal["send-context"] = "send-context"
    id: str = Field(default_factory=_new_message_id)
    content: str = Field(min_length=1, max_length=_CONTEXT_NOTE_MAX_CHARS)


class ClientActivityEnd(BaseModel):
    """Client signals end-of-turn (manual VAD)."""

    type: Literal["activity-end"] = "activity-end"
    id: str = Field(default_factory=_new_message_id)


class ClientImage(BaseModel):
    """One image frame from the client — screen share, camera capture, or any
    other visual input. ``data`` is base64-encoded image bytes."""

    type: Literal["send-image"] = "send-image"
    id: str = Field(default_factory=_new_message_id)
    mime_type: str = "image/jpeg"
    data: str
    stream_id: str = "video.input.default"


class ToolJobResult(BaseModel):
    """Terminal result of a long-running (deferred) client tool.

    The SDK sends this over the data channel when a tool's background job calls
    ``job.complete(...)`` / ``job.fail(...)``. The server resolves the original
    tool call from ``job_id`` and injects the outcome into the live session.
    ``summary`` / ``error`` are the model-facing text; ``result`` is structured
    data logged server-side."""

    type: Literal["tool_job_result"] = "tool_job_result"
    id: str = Field(default_factory=_new_message_id)
    job_id: str
    tool_name: str
    status: Literal["completed", "failed"]
    result: dict[str, Any] | None = None
    summary: str | None = None
    error: str | None = None


class ClientEnvelope(BaseModel):
    """Generic chunked carrier for any oversized client message. ``data`` is
    a base64-encoded fragment of the UTF-8 bytes of the inner message JSON."""

    type: Literal["envelope-chunk"] = "envelope-chunk"
    id: str = Field(default_factory=_new_message_id)
    envelope_id: str
    seq: int
    total: int
    data: str


RealtimeClientMessage = Annotated[
    Union[
        SessionConfig,
        ClientMute,
        ClientEnd,
        ClientPing,
        ClientBindInput,
        ClientText,
        ClientContext,
        ClientActivityEnd,
        ClientImage,
        ToolJobResult,
        ClientEnvelope,
    ],
    Field(discriminator="type"),
]


# ─────────────────────────────────────────────────────────────────────────────
# Server → client
# ─────────────────────────────────────────────────────────────────────────────


class RejectedTool(BaseModel):
    """One tool spec the server refused, with the reason."""

    name: str
    reason: str


class ResolvedAgent(BaseModel):
    """Resolved-agent summary echoed on ``ready`` when the session referenced a
    catalog agent (``agent.name``). Informational only — never authoritative;
    clients don't act on it."""

    name: str
    tools: list[str] = Field(default_factory=list)


class ReadyEvent(BaseModel):
    """Sent after the upstream session is established and the agent is ready."""

    type: Literal["ready"] = "ready"
    id: str = Field(default_factory=_new_message_id)
    session_id: str
    rejected_tools: list[RejectedTool] = Field(default_factory=list)
    max_session_seconds: int | None = None
    """Effective wall-clock cap the server resolved for this session, in seconds
    (min of the client's requested cap and the server's own limits). ``None``
    when no cap applies."""
    agent: ResolvedAgent | None = None
    """Which catalog agent resolved and the tool names it runs with.
    ``None`` for inline agents."""


class TranscriptDeltaEvent(BaseModel):
    """Streaming transcript event for either speaker.

    Streaming events (``is_final=False``) carry the new fragment since the
    previous event for that role's turn; the terminating event
    (``is_final=True``) carries the cumulative full transcript for the turn.

    So the final **replaces** what the fragments built, it does not extend it::

        text = delta.text if delta.is_final else text + delta.text

    Appending the final instead duplicates the turn — most visibly when a turn
    arrives in one piece, where the sole fragment already holds the whole
    sentence and the final then repeats it verbatim.

    Two carve-outs where the final is not the full turn:

    * A turn may finalize with empty ``text`` when the model produced nothing
      usable (a suppressed or garbled turn). That means an empty turn, not
      "unchanged".
    * On a session running ``audio.output=False``, a user final arriving after
      the VAD endpoint already committed the utterance carries only the
      remaining suffix, so replacing wholesale drops the committed prefix.
    """

    type: Literal["transcript"] = "transcript"
    id: str = Field(default_factory=_new_message_id)
    role: TranscriptRole
    text: str
    is_final: bool


class ModelTextEvent(BaseModel):
    """Streaming text-channel fragment from the model. Distinct from
    ``transcript``: text the model emits alongside its audio output, not a
    transcription of the audio itself."""

    type: Literal["model-text"] = "model-text"
    id: str = Field(default_factory=_new_message_id)
    text: str
    is_final: bool = False


class TurnCompleteEvent(BaseModel):
    """Marks the end of a turn so the client can finalize a transcript bubble."""

    type: Literal["turn-complete"] = "turn-complete"
    id: str = Field(default_factory=_new_message_id)
    role: TranscriptRole


class UserStartedSpeakingEvent(BaseModel):
    """Server-side VAD detected user voice activity start. Information-only."""

    type: Literal["user-started-speaking"] = "user-started-speaking"
    id: str = Field(default_factory=_new_message_id)


class UserStoppedSpeakingEvent(BaseModel):
    type: Literal["user-stopped-speaking"] = "user-stopped-speaking"
    id: str = Field(default_factory=_new_message_id)


class UserSpeechTimeoutEvent(BaseModel):
    """A server-runtime silence hook fired: the user was silent past the
    configured threshold and the server performed ``action``."""

    type: Literal["user-speech-timeout"] = "user-speech-timeout"
    id: str = Field(default_factory=_new_message_id)
    session_id: str
    silence_ms: int
    trigger_count: int
    max_count: int
    action: ServerHookAction


class BotStartedSpeakingEvent(BaseModel):
    """First audio frame of an assistant turn left the server. Information-only."""

    type: Literal["bot-started-speaking"] = "bot-started-speaking"
    id: str = Field(default_factory=_new_message_id)


class BotStoppedSpeakingEvent(BaseModel):
    type: Literal["bot-stopped-speaking"] = "bot-stopped-speaking"
    id: str = Field(default_factory=_new_message_id)


class BotLlmStartedEvent(BaseModel):
    """Model began generating its turn (first text or audio event arrived)."""

    type: Literal["bot-llm-started"] = "bot-llm-started"
    id: str = Field(default_factory=_new_message_id)


class BotLlmStoppedEvent(BaseModel):
    type: Literal["bot-llm-stopped"] = "bot-llm-stopped"
    id: str = Field(default_factory=_new_message_id)


class BotTtsStartedEvent(BaseModel):
    """Assistant TTS audio frames started flowing."""

    type: Literal["bot-tts-started"] = "bot-tts-started"
    id: str = Field(default_factory=_new_message_id)


class BotTtsStoppedEvent(BaseModel):
    type: Literal["bot-tts-stopped"] = "bot-tts-stopped"
    id: str = Field(default_factory=_new_message_id)


class ToolCallEvent(BaseModel):
    """Model decided to invoke a server-executed tool.

    Three-event lifecycle: ``tool-call`` → ``tool-dispatch-started`` →
    ``tool-result``, correlated by ``tool_call_id``.
    """

    type: Literal["tool-call"] = "tool-call"
    id: str = Field(default_factory=_new_message_id)
    tool_call_id: str
    name: str


class ToolDispatchStartedEvent(BaseModel):
    """Server-side handler for the tool call began executing."""

    type: Literal["tool-dispatch-started"] = "tool-dispatch-started"
    id: str = Field(default_factory=_new_message_id)
    tool_call_id: str
    name: str


class ToolResultEvent(BaseModel):
    """Server-side tool finished. ``summary`` is a short human-readable line."""

    type: Literal["tool-result"] = "tool-result"
    id: str = Field(default_factory=_new_message_id)
    tool_call_id: str
    ok: bool
    summary: str | None = None


RealtimeToolInvocationOrigin = Literal["realtime", "server"]


class ToolInvocationEvent(BaseModel):
    """Server asks the connected client to run a tool locally.

    Sent only for tools declared via :class:`ClientTool` specs at session
    start. Surfaced as an observability event.
    """

    type: Literal["tool-invocation"] = "tool-invocation"
    id: str = Field(default_factory=_new_message_id)
    request_id: str
    tool_call_id: str
    name: str
    args: dict[str, Any] = Field(default_factory=dict)
    origin: RealtimeToolInvocationOrigin = "realtime"
    executable: bool = True


class ReconnectingEvent(BaseModel):
    """Server is transparently rotating the upstream session. The transport
    and session state survive the swap."""

    type: Literal["reconnecting"] = "reconnecting"
    id: str = Field(default_factory=_new_message_id)
    seconds_remaining: float | None = None


class SessionEndedEvent(BaseModel):
    """Terminal ``session-ended`` — the session is over and no further events
    follow.

    Dual role. The server publishes this frame best-effort just before a
    deliberate teardown (clean end, user end, duration or silence timeout);
    the SDK latches its ``reason`` and never surfaces the frame mid-stream.
    The SDK then synthesizes the single terminal instance the event stream
    yields at teardown, carrying the latched reason when one arrived.
    """

    type: Literal["session-ended"] = "session-ended"
    id: str = Field(default_factory=_new_message_id)
    reason: str | None = None


class ErrorEvent(BaseModel):
    """Recoverable or terminal error. ``fatal=True`` signals the session is
    dead; ``fatal=False`` means this turn failed but the session continues."""

    type: Literal["error"] = "error"
    id: str = Field(default_factory=_new_message_id)
    code: ErrorCode
    message: str
    fatal: bool = False


class UsageEvent(BaseModel):
    """Cumulative token usage for the live session, split by direction and
    modality.

    Every field is a running total for the session so far, not a per-turn
    delta — the newest event supersedes the previous one. Emitted whenever the
    upstream provider reports usage; a provider that reports none
    yields no usage events at all, so absence is not zero usage.
    """

    type: Literal["cosmo.usage"] = "cosmo.usage"
    id: str = Field(default_factory=_new_message_id)
    input_text_tokens: int = 0
    input_image_tokens: int = 0
    input_audio_tokens: int = 0
    input_cached_tokens: int = 0
    output_text_tokens: int = 0
    output_audio_tokens: int = 0
    total_tokens: int = 0


class SessionStateWriteEvent(BaseModel):
    """Live session state after the agent wrote to it with ``set_state``.

    ``state`` is the full canonical state rather than a delta, so the newest
    event supersedes the previous one; ``updated_keys`` names just the keys
    this write touched. ``stage`` is hoisted out of ``state["stage"]`` for
    convenience, and ``warnings`` are the advisory schema findings the model
    saw in its own tool result.
    """

    type: Literal["cosmo.session-state"] = "cosmo.session-state"
    id: str = Field(default_factory=_new_message_id)
    state: dict[str, Any] = Field(default_factory=dict)
    updated_keys: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    stage: str | None = None


class PongEvent(BaseModel):
    """Reply to ``ClientPing``."""

    type: Literal["pong"] = "pong"
    id: str = Field(default_factory=_new_message_id)


class ServerEnvelope(BaseModel):
    """Generic chunked carrier for any oversized server message. The SDK
    buffers by ``envelope_id``, base64-decodes + concatenates in ``seq``
    order, and re-dispatches the inner message — chunks never surface as
    events."""

    type: Literal["server-envelope-chunk"] = "server-envelope-chunk"
    id: str = Field(default_factory=_new_message_id)
    envelope_id: str
    seq: int
    total: int
    data: str


class UnknownEvent(BaseModel):
    """Forward-compatibility variant for unrecognized or undecodable frames.

    ``raw_type`` carries the wire ``type`` the SDK could not handle, or
    ``None`` when the frame was not decodable JSON at all (``raw_text`` then
    carries the frame verbatim). Never terminal — the stream continues.
    """

    type: Literal["unknown"] = "unknown"
    raw_type: str | None
    payload: dict[str, Any] | None = None
    raw_text: str | None = None


RealtimeSessionEvent = Union[
    ReadyEvent,
    TranscriptDeltaEvent,
    ModelTextEvent,
    TurnCompleteEvent,
    UserStartedSpeakingEvent,
    UserStoppedSpeakingEvent,
    BotStartedSpeakingEvent,
    BotStoppedSpeakingEvent,
    BotLlmStartedEvent,
    BotLlmStoppedEvent,
    BotTtsStartedEvent,
    BotTtsStoppedEvent,
    ToolCallEvent,
    ToolDispatchStartedEvent,
    ToolResultEvent,
    ToolInvocationEvent,
    ReconnectingEvent,
    SessionEndedEvent,
    ErrorEvent,
    PongEvent,
    SessionStateWriteEvent,
    UsageEvent,
    UserSpeechTimeoutEvent,
    UnknownEvent,
]
"""Everything ``async for event in session`` can yield. ``SessionEndedEvent``
is always the final item."""


# ─────────────────────────────────────────────────────────────────────────────
# Session-start REST response
# ─────────────────────────────────────────────────────────────────────────────


class SessionStartTimings(BaseModel):
    """Server-side phase breakdown of session start (milliseconds).

    A phase the serving flow doesn't have reports ``0`` rather than a
    fabricated split; ``resolve_ms`` covers the server's single
    resolution seam and is absent from a backend that predates it.
    """

    version_check_ms: int
    project_check_ms: int
    provider_resolve_ms: int
    db_insert_ms: int
    mint_tokens_ms: int
    dispatch_ms: int
    total_ms: int
    resolve_ms: int | None = None


class SessionResponse(BaseModel):
    """Join credentials returned by POST ``session/start``."""

    livekit_url: str
    token: str
    room_name: str
    session_id: str
    timings: SessionStartTimings | None = None


class MintedToken(BaseModel):
    """End-user token returned by ``RealtimeClient.mint_token`` (POST
    ``auth/token``): a short-lived JWT scoped to one external user, safe to
    hand to a browser/device, usable as the ``token`` credential.

    ``token_id`` is the server-side revocation handle
    (``DELETE auth/token/{token_id}``) — keep it on your server; the device
    only needs ``jwt``. Cosmo always returns it; it is optional here because
    this model doubles as the ``TokenSource`` fetch shape, whose contract is
    any backend returning ``{jwt, expires_at}``."""

    jwt: str
    expires_at: datetime
    token_id: str | None = None


class CredentialKind(str, Enum):
    """Which of the two realtime credentials the server saw."""

    API_KEY = "api_key"
    USER_TOKEN = "user_token"


class WorkspaceInfo(BaseModel):
    """The workspace a credential is bound to."""

    name: str
    slug: str


class CredentialInfo(BaseModel):
    """What :meth:`RealtimeClient.verify` learned about this credential (GET
    ``realtime/verify``). Returning at all means the credential authenticated
    against this deployment; the fields say what it can do from here."""

    credential: CredentialKind
    workspace: WorkspaceInfo | None = None
    """The workspace the credential is bound to. Present for an API key, which
    the workspace's own developer holds; ``None`` for a minted token, which is
    held by an end user."""

    scopes: list[str]
    can_start_sessions: bool
    realtime_voice_available: bool
    external_user_id: str | None = None


class DialResult(BaseModel):
    """Outcome of :meth:`RealtimeSession.dial` (POST ``session/{id}/dial``):
    the dial was queued. The call rings asynchronously — observe progress via
    session events, not this return value. ``dial_id`` is the handle to
    correlate the call (e.g. with server-side dial status)."""

    dial_id: UUID


class SessionStatus(str, Enum):
    """Lifecycle state of a voice session."""

    ACTIVE = "active"
    COMPLETED = "completed"
    ERROR = "error"


class UsageStatus(str, Enum):
    """Whether a session's detailed usage summary is available.

    ``PENDING`` while the session runs and for a short window after it
    ends, before the summary is written. ``RECORDED`` once it is there
    and the numbers are final. ``UNAVAILABLE`` once that window has
    passed without one arriving: a session with no turn or speech
    activity records none, and neither does one torn down abnormally.
    """

    PENDING = "pending"
    RECORDED = "recorded"
    UNAVAILABLE = "unavailable"


class SessionTokenUsage(BaseModel):
    """Token usage reported by the session's model provider, split by
    direction and modality. The live ``cosmo.usage`` event
    (:class:`UsageEvent`) counters plus the input and output totals, with
    the same cumulative semantics."""

    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    input_audio_tokens: int = 0
    input_text_tokens: int = 0
    input_image_tokens: int = 0
    input_cached_tokens: int = 0
    output_audio_tokens: int = 0
    output_text_tokens: int = 0


class SessionUsage(BaseModel):
    """Usage summary for one session, in provider-reported units.

    ``duration_seconds`` is set once the session ends. The rest of the
    detail arrives with the summary, so it is present only while
    ``usage_status`` is :attr:`UsageStatus.RECORDED`, at which point the
    numbers are final. ``tokens`` is ``None`` when the provider reports
    none.

    ``status`` and ``usage_status`` fall back to the raw string for a
    value this SDK version predates, so a new server state reads rather
    than raising."""

    status: Annotated[SessionStatus | str, Field(union_mode="left_to_right")]
    usage_status: Annotated[UsageStatus | str, Field(union_mode="left_to_right")]
    duration_seconds: float | None = None
    turn_count: int | None = None
    user_speaking_seconds: float | None = None
    agent_speaking_seconds: float | None = None
    provider: str | None = None
    model: str | None = None
    tokens: SessionTokenUsage | None = None
