"""A live realtime session: typed async event stream + send methods.

Consumption model::

    async with agent.start() as session:
        async for event in session:
            match event:
                case TranscriptDeltaEvent():
                    ...

The stream yields :data:`~cosmo_ai._internal.protocol.RealtimeSessionEvent`
members. Unrecognized or undecodable frames surface as
:class:`~cosmo_ai._internal.protocol.UnknownEvent` and never end the stream;
:class:`~cosmo_ai._internal.protocol.SessionEndedEvent` is always the final
item, synthesized locally on :meth:`RealtimeSession.end` / transport close,
after which iteration finishes.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import math
import time
from dataclasses import dataclass
from enum import Enum
from typing import Any, AsyncIterator, Awaitable, Callable, Coroutine, Optional

import structlog
from pydantic import BaseModel, ValidationError

from cosmo_ai._internal.logging import get_logger
from cosmo_ai.tools._jobs import ClientToolJobSink
from cosmo_ai.tools._dispatch import register_client_tool_handlers
from cosmo_ai.tools._screen_capture import register_screen_locate
from cosmo_ai._internal.transport import Transport, TransportCallbacks, TransportClose
from cosmo_ai.audio import AgentAudioFrame, AudioLevels, MicrophoneCapture
from cosmo_ai.errors import (
    AudioPublishAlreadyActiveError,
    DialError,
    NotConnectedError,
    SessionStartError,
    UsageError,
)
from cosmo_ai.audio._broadcast import AgentAudioBroadcaster, rms_int16
from cosmo_ai.session._video import VideoStreamHandle
from cosmo_ai._internal.hooks import (
    DisconnectReason,
    HookEngine,
    SessionEndContext,
    SessionStartContext,
)
from cosmo_ai._internal.protocol import (
    ClientTool,
    DialResult,
    SessionUsage,
    BotLlmStartedEvent,
    BotLlmStoppedEvent,
    BotStartedSpeakingEvent,
    BotStoppedSpeakingEvent,
    BotTtsStartedEvent,
    BotTtsStoppedEvent,
    ClientActivityEnd,
    ClientBindInput,
    ClientContext,
    ClientEnd,
    ClientImage,
    ClientMute,
    ClientPing,
    CatalogAgentConfig,
    ClientText,
    UserSpeechTimeoutEvent,
    ErrorEvent,
    ModelTextEvent,
    PongEvent,
    ReadyEvent,
    ReconnectingEvent,
    ServerEnvelope,
    SessionConfig,
    SessionStateWriteEvent,
    UsageEvent,
    SessionEndedEvent,
    RealtimeSessionEvent,
    SessionResponse,
    SessionStartTimings,
    ToolCallEvent,
    ToolDispatchStartedEvent,
    ToolInvocationEvent,
    ToolResultEvent,
    TranscriptDeltaEvent,
    TurnCompleteEvent,
    UserStartedSpeakingEvent,
    UserStoppedSpeakingEvent,
    UnknownEvent,
)

logger: structlog.stdlib.BoundLogger = get_logger(__name__)


class SessionStateKind(str, Enum):
    """Transport-level lifecycle of the session."""

    IDLE = "idle"
    CONNECTING = "connecting"
    CONNECTED = "connected"
    RECONNECTING = "reconnecting"
    DISCONNECTED = "disconnected"


@dataclass(frozen=True)
class RealtimeSessionState:
    """Snapshot of the session lifecycle; ``disconnect_reason`` is populated
    on ``DISCONNECTED`` transitions."""

    kind: SessionStateKind
    disconnect_reason: DisconnectReason | None = None
    detail: str | None = None


@dataclass(frozen=True)
class SessionConnectTimings:
    """Connect-latency breakdown: the client-measured phases of this
    session's start plus the server's own breakdown from the start response.

    ``ws_ms`` is the REST session-start round trip, ``room_ms`` the LiveKit
    join, ``total_ms`` the whole start. ``mic_ms`` is ``None`` here — this SDK
    publishes audio through an explicit call rather than during the join, so
    there is no mic phase to measure. Every field is ``None`` before the
    corresponding phase completes; ``server_timings`` is ``None`` on a backend
    that doesn't report it.
    """

    ws_ms: float | None = None
    room_ms: float | None = None
    mic_ms: float | None = None
    total_ms: float | None = None
    server_timings: SessionStartTimings | None = None


OnStateChange = Callable[[RealtimeSessionState], None]
PostDial = Callable[[str, str, Optional[str]], Awaitable[DialResult]]
"""Bound ``RealtimeClient._post_dial`` — ``(session_id, phone_number,
caller_number) -> DialResult`` — injected so a session can place a dial
through the client's authenticated HTTP path without holding the client
itself. ``caller_number`` is the optional E.164 caller-ID."""
GetUsage = Callable[[str], Awaitable[SessionUsage]]
"""Bound ``RealtimeClient.get_session_usage`` — ``(session_id) ->
SessionUsage`` — injected like :data:`PostDial`."""


def _validate_e164(phone_number: str) -> str:
    """Local fast-fail mirror of the server's E.164 check so an obviously
    malformed number raises before the round-trip. ``+`` then 8–15 digits."""
    v = phone_number.strip()
    digits = v[1:]
    if not v.startswith("+") or not digits.isdigit() or not (8 <= len(digits) <= 15):
        raise DialError(
            code="invalid_phone_number",
            message="phone_number must be E.164, e.g. +14155550199",
        )
    return v


_SERVER_EVENT_MODELS: tuple[type[BaseModel], ...] = (
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
    ErrorEvent,
    PongEvent,
    SessionStateWriteEvent,
    UsageEvent,
    UserSpeechTimeoutEvent,
)

_SERVER_EVENT_BY_TYPE: dict[str, type[BaseModel]] = {
    str(cls.model_fields["type"].default): cls for cls in _SERVER_EVENT_MODELS
}


_DEFAULT_ENDED_REASON: dict[DisconnectReason, str] = {
    DisconnectReason.CLIENT_ENDED: "client ended",
    DisconnectReason.CLIENT_CLOSED: "client closed",
    DisconnectReason.HANDSHAKE_FAILED: "handshake failed",
    DisconnectReason.SERVER_ENDED: "server ended",
    DisconnectReason.TRANSPORT_ERROR: "transport error",
}


class _StreamEnd:
    pass


_STREAM_END = _StreamEnd()

# Bound the buffers a misbehaving (or malicious) server could otherwise grow
# without limit. The event queue drops on overflow; in-flight envelopes evict
# the oldest; an envelope claiming too many chunks or accumulating too much
# data is dropped whole. All ceilings sit far above any legitimate session's
# needs (the server chunks at ~8 KB raw per packet).
_MAX_QUEUED_EVENTS = 1024
_MAX_INFLIGHT_ENVELOPES = 64
_MAX_ENVELOPE_CHUNKS = 1024
_MAX_ENVELOPE_TOTAL_CHARS = 4 * 1024 * 1024

# ``session-ended`` is normally followed by the room closing; if that close
# never arrives, finish after this grace so iteration doesn't hang forever.
_SESSION_ENDED_GRACE_SECONDS = 5.0

_LEVELS_INTERVAL_SECONDS = 0.05
# ``agent`` reads 0.0 when no frame arrived within this window: a track using
# DTX stops delivering frames between utterances, and the last RMS must not
# read as "still speaking".
_AGENT_LEVEL_STALE_SECONDS = 0.15


class RealtimeSession:
    """One realtime session — async-iterate it for events, call its send
    methods to talk back. Created by :meth:`RealtimeAgent.start`."""

    def __init__(
        self,
        *,
        config: SessionConfig,
        on_state_change: OnStateChange | None = None,
        post_dial: PostDial | None = None,
        get_usage: GetUsage | None = None,
        on_close: Callable[[], Awaitable[None]] | None = None,
        hooks: HookEngine | None = None,
    ) -> None:
        self._config = config
        self._on_state_change = on_state_change
        self._post_dial = post_dial
        self._get_usage = get_usage
        self._on_close = on_close
        self._hooks = hooks
        self._session_end_fired = False
        self._server_end_reason: str | None = None
        self._state = RealtimeSessionState(kind=SessionStateKind.IDLE)
        self._transport: Transport | None = None
        self._job_sink: ClientToolJobSink | None = None
        self._response: SessionResponse | None = None
        self._connect_timings = SessionConnectTimings()
        self._queue: asyncio.Queue[RealtimeSessionEvent | _StreamEnd] = asyncio.Queue(
            maxsize=_MAX_QUEUED_EVENTS
        )
        self._stream_exhausted = False
        self._terminal = False
        self._background_tasks: set[asyncio.Future[None]] = set()
        self._envelope_buffers: dict[str, dict[int, str]] = {}
        self._envelope_totals: dict[str, int] = {}
        self._envelope_chars: dict[str, int] = {}
        self._mic: Any = None  # _mic.MicAudioSource | None
        self._mic_pub: Any = None  # opaque track publication | None
        # True once this client has published audio and bound the agent's
        # input; drives a re-bind on reconnect so the binding survives a drop.
        self._input_bound = False
        # Last mute state this client asserted; re-asserted on reconnect the
        # same way the input binding is.
        self._muted: bool | None = None
        self._broadcaster = AgentAudioBroadcaster(
            on_first_consumer=self._attach_agent_audio,
            on_last_consumer=self._detach_agent_audio,
        )
        self._speaker: Any = None  # _speaker.SpeakerSink | None
        self._speaker_volume = 1.0
        self._audio_stream: Any = None  # the one caller-owned voice publish

    # ── Public surface ─────────────────────────────────────────────

    @property
    def state(self) -> RealtimeSessionState:
        return self._state

    @property
    def session_id(self) -> str:
        return self._started().session_id

    @property
    def connect_timings(self) -> SessionConnectTimings:
        """Connect-latency breakdown for this session's start.

        A server phase the serving flow doesn't have reports ``0`` rather than
        a fabricated split, so a zero there is a real measurement.
        """
        return self._connect_timings

    def _started(self) -> SessionResponse:
        if self._response is None:
            raise NotConnectedError("Session start did not complete.")
        return self._response

    def __aiter__(self) -> "RealtimeSession":
        return self

    async def __anext__(self) -> RealtimeSessionEvent:
        if self._stream_exhausted:
            raise StopAsyncIteration
        item = await self._queue.get()
        if isinstance(item, _StreamEnd):
            self._stream_exhausted = True
            raise StopAsyncIteration
        return item

    async def send_text(self, content: str) -> None:
        """Send a text message instead of audio.

        The agent replies in whatever modality the session runs in. Configure
        the agent with ``audio=AudioConfig(output=False)`` for a text-only
        session.
        """
        await self._publish(ClientText(content=content))

    async def send_context(self, content: str) -> None:
        """Give the agent context without asking it anything.

        The note lands in the model's context for its next reply and never
        becomes a turn of its own: no spoken response, no assistant message,
        no interruption of what the agent is saying. For live application
        state; :meth:`send_text` is the opposite, it asks.
        """
        await self._publish(ClientContext(content=content))

    async def set_muted(self, muted: bool) -> None:
        """Toggle the server-side mic gate."""
        await self._publish(ClientMute(muted=muted))
        self._muted = muted

    async def ping(self) -> None:
        """Heartbeat; the server replies with a :class:`PongEvent` event."""
        await self._publish(ClientPing())

    async def send_activity_end(self) -> None:
        """Signal end-of-turn for manual-VAD turn-taking."""
        await self._publish(ClientActivityEnd())

    async def send_image(
        self,
        *,
        data: str,
        mime_type: str = "image/jpeg",
        stream_id: str = "video.input.default",
    ) -> None:
        """Send one base64-encoded image frame to the agent."""
        await self._publish(
            ClientImage(data=data, mime_type=mime_type, stream_id=stream_id)
        )

    async def dial(
        self, phone_number: str, *, caller_number: str | None = None
    ) -> DialResult:
        """Place an outbound phone call into this live session's room.

        The dialed party joins as a SIP participant and the agent —
        already in the room — converses with them. Unlike the other
        sends this is an authenticated REST call, not a data-channel
        frame. The call requires phone calls to be enabled for the
        workspace and is bounded by its weekly per-user minute limit
        (enforced server-side, per dial). No start-time flag is needed —
        the server derives phone handling from the dialed leg.

        ``phone_number`` must be E.164 (``+`` then 8–15 digits), e.g.
        ``"+14155550199"``. ``caller_number`` is the E.164 caller-ID to
        present; it must be an ACTIVE number in the workspace pool (the
        server rejects otherwise). ``None`` uses the trunk default. Returns
        once the dial is queued; the call rings asynchronously — watch
        session events for the conversation.

        Raises :class:`DialError` for a malformed number (validated
        locally, before any request) or a server rejection (phone calls
        disabled, over the minute limit, an unavailable caller-ID, an ended
        session, …), and :class:`NotConnectedError` if the session never
        started.
        """
        validated = _validate_e164(phone_number)
        validated_caller = (
            _validate_e164(caller_number) if caller_number is not None else None
        )
        if self._post_dial is None:
            raise DialError(
                code="not_dialable",
                message="This session was not constructed with dial support.",
            )
        return await self._post_dial(self.session_id, validated, validated_caller)

    async def usage(self) -> SessionUsage:
        """Fetch this session's usage summary: duration, talk time, and token
        counts in provider-reported units.

        An authenticated REST read, not a data-channel frame — callable while
        the session is live and, unlike the sends, after it ends. The
        detailed summary is written shortly after the session ends;
        ``usage_status`` on the result reports whether it is present yet.

        Raises :class:`UsageError` on a server rejection or transport
        failure, and :class:`NotConnectedError` if the session never
        started.
        """
        session_id = self.session_id
        if self._get_usage is None:
            raise UsageError(
                code="not_supported",
                message="This session was not constructed with usage support.",
            )
        return await self._get_usage(session_id)

    async def end(self) -> None:
        """Graceful end: tell the server to tear down, then finish the stream
        and leave the room. Idempotent. Teardown is immediate — events still
        in flight are dropped, so consume the turn's final transcript event
        before ending if you need it."""
        if self._terminal:
            return
        # The end frame is a graceful-shutdown courtesy to the worker; when
        # the server already ended the session (room deleted), the transport
        # is disconnected and there is nothing left to end.
        if self._transport is not None and self._transport.is_connected():
            try:
                await self._publish(ClientEnd())
            except NotConnectedError:
                pass
            except Exception:
                logger.exception("realtime.end_send_failed", stack_info=True)
        await self._finish(reason=DisconnectReason.CLIENT_ENDED)

    async def close(self) -> None:
        """Abrupt local teardown without telling the server. Idempotent."""
        await self._finish(reason=DisconnectReason.CLIENT_CLOSED)

    async def __aenter__(self) -> "RealtimeSession":
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        await self.end()

    # ── Audio helpers (LiveKit extra) ──────────────────────────────

    async def set_microphone_enabled(
        self, enabled: bool, *, capture: MicrophoneCapture | None = None
    ) -> None:
        """Capture and publish the default OS microphone (``True``) or stop it
        (``False``), gating the server side to match.

        ``capture`` selects which processors run on the audio before it is sent
        (see :class:`MicrophoneCapture`); the defaults suit a session played
        through speakers. Ignored when disabling, and when a microphone is
        already publishing — stop it first to change the policy.

        For non-mic audio (synthetic, WAV replay) use
        :meth:`start_audio_stream`."""
        if enabled:
            self._require_transport()
            if self._mic is None:
                from cosmo_ai.audio import _mic

                if self._audio_stream is not None:
                    raise AudioPublishAlreadyActiveError(
                        "an audio stream is publishing — a session carries one "
                        "voice; call stop_audio_stream() before the microphone"
                    )
                mic = _mic.MicAudioSource(capture)
                await mic.start()  # opens the device before anything is published
                try:
                    pub = await self._publish_audio(mic.livekit_source)
                except BaseException:
                    await mic.stop()
                    raise
                mic.set_level_source(getattr(pub, "track", None))
                self._mic_pub = pub
                self._mic = mic
        else:
            await self._stop_microphone(unpublish=True)
            await self.set_muted(True)

    async def _stop_microphone(self, *, unpublish: bool) -> None:
        mic, self._mic = self._mic, None
        pub, self._mic_pub = self._mic_pub, None
        if mic is not None:
            await mic.stop()
        if unpublish and pub is not None and self._transport is not None:
            await self._transport.unpublish_track(pub)

    async def start_audio_stream(
        self, source: Any, *, track_name: str = "mic"
    ) -> None:
        """Take the session's voice with a caller-owned ``rtc.AudioSource``.

        For audio the SDK cannot capture itself: a synthetic generator, WAV
        replay, a load generator, or any pipeline running where there is no
        input device. You own the source and keep it fed through
        ``source.capture_frame(...)``. For the OS microphone use
        :meth:`set_microphone_enabled`.

        A session carries one voice, so this raises
        :class:`~cosmo_ai.errors.AudioPublishAlreadyActiveError` while the
        microphone or another stream holds it."""
        self._require_transport()
        if self._mic is not None:
            raise AudioPublishAlreadyActiveError(
                "the microphone is publishing — a session carries one voice; "
                "call set_microphone_enabled(False) before starting a stream"
            )
        if self._audio_stream is not None:
            raise AudioPublishAlreadyActiveError(
                "an audio stream is already publishing — a session carries one "
                "voice; call stop_audio_stream() before starting another"
            )
        self._audio_stream = await self._publish_audio(source, track_name=track_name)

    async def stop_audio_stream(self) -> None:
        """Give the voice back: unpublish the running stream and close the
        server-side gate, leaving the session with no voice until the
        microphone or another stream takes it. Idempotent."""
        publication, self._audio_stream = self._audio_stream, None
        if publication is None:
            return
        if self._transport is not None:
            await self._transport.unpublish_track(publication)
        await self.set_muted(True)

    async def _publish_audio(self, source: Any, *, track_name: str = "mic") -> Any:
        publication = await self._require_transport().publish_audio_source(
            source, track_name=track_name
        )
        # Publishing audio makes this client the human voice: bind the agent's
        # input so it listens to us specifically, not to whoever else publishes.
        await self._send_bind_input()
        await self.set_muted(False)
        return publication

    async def _send_bind_input(self) -> None:
        """Tell the server this client is the human voice — bind the agent's
        input to us. Best-effort: a transient data-channel failure must not
        fail the publish that triggered it (a reconnect re-binds). Records
        ``_input_bound`` first so the re-bind fires even if this send fails."""
        self._input_bound = True
        try:
            await self._publish(ClientBindInput())
        except Exception:
            logger.exception("realtime.bind_input_failed", stack_info=True)

    def _attach_agent_audio(self) -> None:
        transport = self._transport
        if transport is not None:
            transport.set_agent_audio_sink(self._broadcaster)

    def _detach_agent_audio(self) -> None:
        transport = self._transport
        if transport is not None:
            transport.set_agent_audio_sink(None)

    async def agent_audio(self) -> AsyncIterator[AgentAudioFrame]:
        """The agent's decoded voice as 16-bit mono PCM
        :class:`AgentAudioFrame`\\ s — record it, pipe it elsewhere, or feed a
        custom player. Frames flow once the agent publishes audio; the
        iterator finishes when the session ends. Multiple concurrent
        iterators each receive every frame; a stalled consumer drops its
        oldest frames. Requires a started session."""
        self._require_transport()
        consumer = self._broadcaster.subscribe()
        try:
            async for frame in consumer:
                yield frame
        finally:
            self._broadcaster.unsubscribe(consumer)

    async def set_speaker_enabled(self, enabled: bool) -> None:
        """Play the agent's voice on the default OS output device (``True``)
        or stop (``False``). For custom playback consume :meth:`agent_audio`
        directly. Idempotent."""
        if enabled:
            self._require_transport()
            if self._speaker is None:
                from cosmo_ai.audio import _sounddevice, _speaker

                _sounddevice.ensure_sounddevice()  # fail before subscribing to agent audio
                speaker = _speaker.SpeakerSink(volume=self._speaker_volume)
                await speaker.start(self.agent_audio())
                self._speaker = speaker
        else:
            speaker, self._speaker = self._speaker, None
            if speaker is not None:
                await speaker.stop()

    def set_agent_playback_volume(self, volume: float) -> None:
        """Software gain for OS playback of the agent's voice: ``0`` mutes,
        ``1`` is unity; values outside 0…1 are clamped and NaN is rejected.
        Only affects :meth:`set_speaker_enabled` output, never
        :meth:`agent_audio` frames. May be called before the speaker is
        enabled; the value persists and applies when it starts."""
        if math.isnan(volume):
            raise ValueError("volume must be a number, got NaN")
        clamped = min(max(volume, 0.0), 1.0)
        self._speaker_volume = clamped
        if self._speaker is not None:
            self._speaker.set_volume(clamped)

    async def audio_levels(self) -> AsyncIterator[AudioLevels]:
        """Mic and agent RMS levels (0…1) sampled at a fixed ~20 Hz cadence,
        latest-value — a slow consumer skips samples, it never lags. ``mic``
        is live while the microphone is publishing; iterating activates the
        agent frame path, so ``agent`` is live once the agent's track exists.
        ``agent`` decays to ``0.0`` when the agent's track stops delivering
        frames (silence between utterances). Finishes when the session ends.
        Requires a started session."""
        self._require_transport()
        loop = asyncio.get_running_loop()
        agent_level = 0.0
        last_frame_at: float | None = None
        consumer = self._broadcaster.subscribe()

        async def _drain() -> None:
            nonlocal agent_level, last_frame_at
            try:
                async for frame in consumer:
                    agent_level = rms_int16(frame.data)
                    last_frame_at = loop.time()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("realtime.audio_levels_drain_failed", stack_info=True)

        drain = asyncio.ensure_future(_drain())
        try:
            while not self._terminal:
                await asyncio.sleep(_LEVELS_INTERVAL_SECONDS)
                if self._terminal:
                    return
                mic = await self._mic.read_level() if self._mic is not None else 0.0
                stale = (
                    last_frame_at is None
                    or loop.time() - last_frame_at > _AGENT_LEVEL_STALE_SECONDS
                )
                yield AudioLevels(mic=mic, agent=0.0 if stale else agent_level)
        finally:
            self._broadcaster.unsubscribe(consumer)
            drain.cancel()
            try:
                await drain
            except asyncio.CancelledError:
                pass

    # ── Screen share ───────────────────────────────────────────────

    async def start_screen_share(
        self, *, width: int = 1920, height: int = 1080
    ) -> None:
        """Create the screen-share track; the publish is deferred to the first
        :meth:`push_screen_share_frame` so frame dimensions can be resolved from
        the source. Idempotent (restarts an active share)."""
        await self._require_transport().start_screen_share(width=width, height=height)

    async def push_screen_share_frame(self, frame: Any) -> None:
        """Push one captured ``rtc.VideoFrame`` into the active share. No-op
        without :meth:`start_screen_share`."""
        transport = self._transport
        if transport is not None:
            transport.push_screen_share_frame(frame)

    async def stop_screen_share(self) -> None:
        """Unpublish the active screen-share track. Idempotent."""
        transport = self._transport
        if transport is not None:
            await transport.stop_screen_share()

    # ── Video streams ──────────────────────────────────────────────

    async def add_video_stream(
        self, *, width: int = 1280, height: int = 720
    ) -> VideoStreamHandle:
        """Publish video that is not the user's screen — a camera, a file, any
        pixels-only source — and return the handle to push frames into::

            stream = await session.add_video_stream()
            stream.push(rtc.VideoFrame(w, h, rtc.VideoBufferType.RGB24, pixels))

        The backend narrates the two apart, so a camera feed is described as
        one and the screen tools stay anchored to actual screen shares.
        Capturing the frames is yours: any source that can produce an
        ``rtc.VideoFrame`` works, and nothing here opens a device.

        One video publish at a time — raises
        :class:`~cosmo_ai.errors.VideoPublishAlreadyActiveError` while a stream
        or a screen share is live. The publish is deferred to the first frame,
        so dimensions resolve from the source.
        """
        transport = self._require_transport()
        stream_id = await transport.add_video_stream(width=width, height=height)
        return VideoStreamHandle(stream_id, transport.push_video_frame)

    async def remove_video_stream(self, handle: VideoStreamHandle) -> None:
        """Stop a stream from :meth:`add_video_stream`. Identity-keyed and
        idempotent: a stale handle is a no-op."""
        transport = self._transport
        if transport is not None:
            await transport.remove_video_stream(handle.stream_id)

    # ── Lifecycle internals ────────────────────────────────────────

    async def _start(
        self,
        start_remote: Callable[
            [SessionConfig], Awaitable[SessionResponse]
        ],
    ) -> "RealtimeSession":
        self._set_state(SessionStateKind.CONNECTING)
        try:
            await self._apply_session_start_hooks()
        except Exception as exc:
            logger.exception("realtime.session_start_hook_failed", stack_info=True)
            await self._abort_start(DisconnectReason.HANDSHAKE_FAILED, str(exc))
            raise SessionStartError(
                code="session_start_hook_failed", message=str(exc)
            ) from exc
        started_at = time.perf_counter()
        try:
            response = await start_remote(self._config)
        except asyncio.CancelledError:
            await self._abort_start(DisconnectReason.CLIENT_CLOSED, "start cancelled")
            raise
        except SessionStartError as exc:
            await self._abort_start(DisconnectReason.HANDSHAKE_FAILED, str(exc))
            raise
        ws_done_at = time.perf_counter()
        try:
            await self._connect_transport(response)
        except asyncio.CancelledError:
            await self._abort_start(DisconnectReason.CLIENT_CLOSED, "start cancelled")
            raise
        except ImportError:
            await self._abort_start(DisconnectReason.TRANSPORT_ERROR, None)
            raise
        except Exception as exc:
            await self._abort_start(DisconnectReason.TRANSPORT_ERROR, str(exc))
            raise SessionStartError(code="room_join_failed", message=str(exc)) from exc
        connected_at = time.perf_counter()
        self._response = response
        self._connect_timings = SessionConnectTimings(
            ws_ms=(ws_done_at - started_at) * 1000,
            room_ms=(connected_at - ws_done_at) * 1000,
            total_ms=(connected_at - started_at) * 1000,
            server_timings=response.timings,
        )
        self._set_state(SessionStateKind.CONNECTED)
        logger.info(
            "realtime.session_started",
            session_id=response.session_id,
            room_name=response.room_name,
        )
        return self

    async def _abort_start(self, reason: DisconnectReason, detail: str | None) -> None:
        """Bookkeeping for a start that never reached CONNECTED: latch terminal,
        fire SessionEnd, land the stream sentinel, record the disconnect."""
        self._terminal = True
        await self._fire_session_end(reason, detail)
        self._put_terminal(_STREAM_END)
        self._set_state(SessionStateKind.DISCONNECTED, reason=reason, detail=detail)

    async def _apply_session_start_hooks(self) -> None:
        if self._hooks is None:
            return
        extra = await self._hooks.run_session_start(SessionStartContext())
        if not extra:
            return
        agent = self._config.agent
        if isinstance(agent, CatalogAgentConfig):
            logger.warning(
                "realtime.session_start_hook_context_dropped",
                detail="a catalog agent runs its stored config verbatim — "
                "SessionStart additional_context is not injected",
            )
            return
        base = agent.instructions
        merged = f"{base}\n\n{extra}" if base else extra
        self._config = self._config.model_copy(
            update={"agent": agent.model_copy(update={"instructions": merged})}
        )
        logger.info(
            "realtime.session_start_hook_context_folded", added_chars=len(extra)
        )

    async def _fire_session_end(
        self, reason: DisconnectReason, detail: str | None
    ) -> None:
        if self._hooks is None or self._session_end_fired:
            return
        self._session_end_fired = True
        session_id = self._response.session_id if self._response is not None else None
        await self._hooks.run_session_end(
            SessionEndContext(reason=reason, detail=detail, session_id=session_id)
        )

    def _make_transport(self) -> Transport:
        """Construct the production transport. Isolated so tests inject a fake by
        patching this one method; the livekit import is deferred to here to
        keep importing the SDK light."""
        from cosmo_ai.session._livekit import LiveKitTransport

        return LiveKitTransport()

    async def _connect_transport(self, response: SessionResponse) -> None:
        self._transport = self._make_transport()
        callbacks = TransportCallbacks(
            on_frame=self._on_transport_frame,
            on_closed=self._on_transport_closed,
            on_reconnecting=self._on_transport_reconnecting,
            on_reconnected=self._on_transport_reconnected,
        )
        try:
            # Register RPC methods BEFORE the join (the transport binds
            # pre-connect registrations before delivering any inbound
            # invocation), so a tool call arriving in the join window is
            # handled instead of failing "method not found".
            self._job_sink = ClientToolJobSink(
                publish=self._publish,
                is_open=lambda: not self._terminal and self._transport is not None,
            )
            register_client_tool_handlers(
                self._transport,
                self._client_tools(),
                hooks=self._hooks,
                session_id=response.session_id,
                job_sink=self._job_sink,
            )
            # The locator's capture RPC is registered without being advertised:
            # the model never calls it, cosmo_screen_locate does.
            register_screen_locate(self._transport, self._config.agent.tools or ())
            await self._transport.connect(response, callbacks)
        except BaseException:
            # BaseException: a cancelled or failed handshake must not leak a
            # live room.
            transport, self._transport = self._transport, None
            try:
                await asyncio.shield(transport.disconnect())
            except Exception:
                logger.exception(
                    "realtime.transport_disconnect_failed", stack_info=True
                )
            raise

    def _client_tools(self) -> list[ClientTool]:
        tools = self._config.agent.tools
        if tools is None:
            return []
        return [tool for tool in tools if isinstance(tool, ClientTool)]

    async def _finish(
        self,
        *,
        reason: DisconnectReason,
        detail: str | None = None,
        ended_event: SessionEndedEvent | None = None,
    ) -> None:
        if self._terminal:
            return
        self._terminal = True
        # Cancel any in-flight long-running client-tool jobs; their results have
        # nowhere to land once the session is torn down.
        if self._job_sink is not None:
            self._job_sink.close()
        await self._fire_session_end(reason, detail)
        if ended_event is None:
            ended_event = SessionEndedEvent(
                reason=detail or _DEFAULT_ENDED_REASON[reason]
            )
        self._put_terminal(ended_event)
        self._put_terminal(_STREAM_END)
        self._set_state(SessionStateKind.DISCONNECTED, reason=reason, detail=detail)
        transport = self._transport
        self._transport = None
        # The session owns the mic capture source (livekit-rtc Python has no
        # transport-native capture); stop it before the transport disconnects,
        # which drops the published track along with the screen share.
        if self._mic is not None:
            mic, self._mic = self._mic, None
            self._mic_pub = None
            try:
                await mic.stop()
            except Exception:
                logger.exception("realtime.mic_stop_failed", stack_info=True)
        if self._speaker is not None:
            speaker, self._speaker = self._speaker, None
            try:
                await speaker.stop()
            except Exception:
                logger.exception("realtime.speaker_stop_failed", stack_info=True)
        self._broadcaster.close()
        if transport is not None:
            try:
                await transport.disconnect()
            except Exception:
                logger.exception(
                    "realtime.transport_disconnect_failed", stack_info=True
                )
        on_close, self._on_close = self._on_close, None
        if on_close is not None:
            try:
                await on_close()
            except Exception:
                logger.exception("realtime.on_close_failed", stack_info=True)

    def _set_state(
        self,
        kind: SessionStateKind,
        *,
        reason: DisconnectReason | None = None,
        detail: str | None = None,
    ) -> None:
        state = RealtimeSessionState(kind=kind, disconnect_reason=reason, detail=detail)
        previous, self._state = self._state, state
        logger.info(
            "realtime.session_state_changed",
            previous=previous.kind.value,
            kind=kind.value,
            disconnect_reason=reason.value if reason is not None else None,
            detail=detail,
            session_id=(
                self._response.session_id if self._response is not None else None
            ),
        )
        if self._on_state_change is not None:
            try:
                self._on_state_change(state)
            except Exception:
                logger.exception("realtime.state_listener_error", stack_info=True)

    # ── Transport callbacks ────────────────────────────────────────

    def _spawn(self, coro: Coroutine[Any, Any, None]) -> None:
        """Schedule a fire-and-forget coroutine, retaining a strong reference
        so the event loop cannot garbage-collect it mid-flight."""
        task = asyncio.ensure_future(coro)
        self._background_tasks.add(task)
        task.add_done_callback(self._background_tasks.discard)

    def _on_transport_frame(self, payload: bytes) -> None:
        self._spawn(self._handle_payload(payload))

    def _on_transport_closed(self, close: TransportClose) -> None:
        if self._terminal:
            return
        self._spawn(self._finish_transport_close(close))

    async def _session_ended_grace(self) -> None:
        await asyncio.sleep(_SESSION_ENDED_GRACE_SECONDS)
        if not self._terminal:
            logger.warning("realtime.session_ended_without_close")
            await self._finish(
                reason=DisconnectReason.SERVER_ENDED,
                detail=self._server_end_reason,
            )

    async def _finish_transport_close(self, close: TransportClose) -> None:
        # Latch-wins is resolved at task run time: a frame task spawned before
        # the close (a buffered ``session-ended``) has already run and latched.
        reason: DisconnectReason
        detail: str | None
        if self._server_end_reason is not None:
            reason, detail = DisconnectReason.SERVER_ENDED, self._server_end_reason
        elif close.kind == "server_ended":
            reason, detail = DisconnectReason.SERVER_ENDED, close.detail
        else:
            reason, detail = DisconnectReason.TRANSPORT_ERROR, close.detail
        await self._finish(reason=reason, detail=detail)

    def _on_transport_reconnecting(self) -> None:
        if not self._terminal:
            self._set_state(SessionStateKind.RECONNECTING)

    def _on_transport_reconnected(self) -> None:
        if self._terminal:
            return
        self._set_state(SessionStateKind.CONNECTED)
        # The one-shot bind and the mic gate don't survive a transport drop;
        # re-assert both on the recovered connection.
        if self._input_bound:
            self._spawn(self._send_bind_input())
        if self._muted is not None:
            self._spawn(self._resend_mute(self._muted))

    async def _resend_mute(self, muted: bool) -> None:
        """Best-effort mute re-assert after a reconnect."""
        try:
            await self._publish(ClientMute(muted=muted))
        except Exception:
            logger.exception("realtime.mute_reassert_failed", stack_info=True)

    # ── Inbound dispatch ───────────────────────────────────────────

    async def _handle_payload(self, payload: bytes | str) -> None:
        if self._terminal:
            return
        if isinstance(payload, bytes):
            try:
                text = payload.decode("utf-8")
            except UnicodeDecodeError:
                logger.warning("realtime.frame_not_utf8", payload_len=len(payload))
                self._emit(UnknownEvent(raw_type=None))
                return
        else:
            text = payload

        try:
            raw = json.loads(text)
        except json.JSONDecodeError:
            logger.warning("realtime.frame_not_json", payload_len=len(text))
            self._emit(UnknownEvent(raw_type=None, raw_text=text))
            return

        if not isinstance(raw, dict) or not isinstance(raw.get("type"), str):
            logger.warning("realtime.frame_missing_type")
            self._emit(
                UnknownEvent(
                    raw_type=None,
                    payload=raw if isinstance(raw, dict) else None,
                    raw_text=text,
                )
            )
            return

        frame_type: str = raw["type"]
        if frame_type == "server-envelope-chunk":
            try:
                chunk = ServerEnvelope.model_validate(raw)
            except ValidationError:
                logger.warning("realtime.envelope_chunk_invalid")
                self._emit(UnknownEvent(raw_type=frame_type, payload=raw))
                return
            try:
                inner = self._reassemble_envelope(chunk)
            except (binascii.Error, ValueError):
                # A complete envelope whose data is not valid base64 must not
                # kill the handler — base64.b64decode(validate=True) raises
                # binascii.Error; surface UnknownEvent and keep the stream alive.
                logger.warning(
                    "realtime.envelope_decode_failed", envelope_id=chunk.envelope_id
                )
                self._emit(UnknownEvent(raw_type=frame_type, payload=raw))
                return
            if inner is not None:
                await self._handle_payload(inner)
            return

        if frame_type == "session-ended":
            try:
                ended = SessionEndedEvent.model_validate(raw)
            except ValidationError:
                logger.warning(
                    "realtime.event_validation_failed", event_type=frame_type
                )
                self._emit(UnknownEvent(raw_type=frame_type, payload=raw))
                return
            # Latched for the terminal sentinel + SessionEnd hook; never a
            # stream item — the local sentinel stays the single terminal.
            self._server_end_reason = ended.reason
            self._spawn(self._session_ended_grace())
            return

        model_cls = _SERVER_EVENT_BY_TYPE.get(frame_type)
        if model_cls is None:
            self._emit(UnknownEvent(raw_type=frame_type, payload=raw))
            return

        try:
            event = model_cls.model_validate(raw)
        except ValidationError:
            logger.warning("realtime.event_validation_failed", event_type=frame_type)
            self._emit(UnknownEvent(raw_type=frame_type, payload=raw))
            return

        self._emit(event)  # type: ignore[arg-type]

    def _emit(self, event: RealtimeSessionEvent) -> None:
        if self._terminal:
            return
        try:
            self._queue.put_nowait(event)
        except asyncio.QueueFull:
            logger.warning(
                "realtime.event_queue_full_dropping",
                event_type=getattr(event, "type", type(event).__name__),
                qsize=self._queue.qsize(),
            )

    def _put_terminal(self, item: RealtimeSessionEvent | _StreamEnd) -> None:
        """Enqueue a terminal item (the ended event or the stream sentinel),
        evicting buffered events if the queue is full. The sentinel must always
        land or iteration would never finish."""
        while True:
            try:
                self._queue.put_nowait(item)
                return
            except asyncio.QueueFull:
                try:
                    self._queue.get_nowait()
                except asyncio.QueueEmpty:
                    return

    def _reassemble_envelope(self, chunk: ServerEnvelope) -> bytes | None:
        eid = chunk.envelope_id
        total = chunk.total
        if total <= 0 or not (0 <= chunk.seq < total):
            logger.warning(
                "realtime.envelope_chunk_out_of_range",
                envelope_id=eid,
                seq=chunk.seq,
                total=total,
            )
            return None
        if total > _MAX_ENVELOPE_CHUNKS:
            logger.warning(
                "realtime.envelope_chunks_over_limit",
                envelope_id=eid,
                total=total,
            )
            self._drop_envelope(eid)
            return None
        expected = self._envelope_totals.get(eid)
        if expected is None:
            if len(self._envelope_buffers) >= _MAX_INFLIGHT_ENVELOPES:
                oldest = next(iter(self._envelope_buffers))
                self._drop_envelope(oldest)
                logger.warning("realtime.envelope_inflight_evicted", envelope_id=oldest)
            self._envelope_totals[eid] = total
            self._envelope_buffers[eid] = {}
            self._envelope_chars[eid] = 0
        elif expected != total:
            logger.warning(
                "realtime.envelope_total_mismatch",
                envelope_id=eid,
                expected=expected,
                total=total,
            )
            self._drop_envelope(eid)
            return None
        self._envelope_chars[eid] += len(chunk.data)
        if self._envelope_chars[eid] > _MAX_ENVELOPE_TOTAL_CHARS:
            logger.warning(
                "realtime.envelope_size_over_limit",
                envelope_id=eid,
                accumulated_chars=self._envelope_chars[eid],
            )
            self._drop_envelope(eid)
            return None
        buffer = self._envelope_buffers[eid]
        buffer[chunk.seq] = chunk.data
        if len(buffer) < total:
            return None
        self._drop_envelope(eid)
        return b"".join(
            base64.b64decode(buffer[i], validate=True) for i in range(total)
        )

    def _drop_envelope(self, eid: str) -> None:
        self._envelope_buffers.pop(eid, None)
        self._envelope_totals.pop(eid, None)
        self._envelope_chars.pop(eid, None)

    # ── Outbound ───────────────────────────────────────────────────

    async def _publish(self, message: BaseModel) -> None:
        transport = self._require_transport()
        payload = message.model_dump_json(exclude_none=True).encode("utf-8")
        await transport.send_frame(payload)

    def _require_transport(self) -> Transport:
        if self._transport is None:
            raise NotConnectedError("Session is not connected.")
        return self._transport
