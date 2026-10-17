"""The websocket transport: one socket carries the session and its audio.

The sibling of ``_livekit.py`` for a self-hosted ``cosmo-server`` running
``COSMO_TRANSPORT=websocket``. The session above it is unchanged — the same
typed frames, the same client-tool runtime, the same decoded-audio contract
— because everything that differs is quarantined here.

Three things LiveKit did that a plain socket does not, and how each is
handled:

* **Media.** There are no tracks, so audio is raw PCM16 on the socket's
  binary frames. The server states the rates once, before ``ready``; this
  transport resamples to and from them, delivering the agent's voice at the
  SDK's fixed :data:`~cosmo_ai.audio.AGENT_AUDIO_SAMPLE_RATE` so
  ``agent_audio()`` and the speaker sink are none the wiser. There is also
  no device module to cancel echo, so a microphone publish that asks for
  echo cancellation runs WebRTC's canceller in-process
  (:class:`~cosmo_ai.audio._apm.EchoCanceller`), fed from both paths here.
* **RPC.** There is no room RPC, so a client-tool call arrives as an
  ``rpc-request`` frame and its ``{ok, result, error}`` envelope goes back as
  ``rpc-response``. The handlers are the same handlers.
* **Recovery.** There is no reconnection. A dropped socket ends the session,
  which is the trade a local-only transport makes and the reason the LiveKit
  lane is what deploys.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Optional

import structlog

from cosmo_ai._internal.logging import get_logger
from cosmo_ai._internal.protocol import WsSessionStart
from cosmo_ai._internal.transport import (
    AgentAudioSink,
    MicSource,
    RpcHandler,
    RpcInvocation,
    RpcMethodError,
    StartedSession,
    TransportCallbacks,
    TransportClose,
)
from cosmo_ai.audio import AGENT_AUDIO_SAMPLE_RATE, AgentAudioFrame, MicrophoneCapture
from cosmo_ai.audio._apm import EchoCanceller
from cosmo_ai.audio._pcm import PcmAudioSource, PcmMicSource, Resampler
from cosmo_ai.errors import SessionStartErrorCode, SessionStateError, SessionStartError, SessionStateErrorCode

logger: structlog.stdlib.BoundLogger = get_logger(__name__)

WS_AUDIO_FORMAT = "ws-audio-format"
WS_RPC_REQUEST = "rpc-request"
WS_RPC_RESPONSE = "rpc-response"
WS_RPC_CANCEL = "rpc-cancel"

# What to send per binary frame, in samples of captured audio. Twenty
# milliseconds is what the provider's turn detection is used to reading and
# small enough that nothing waits on a frame boundary.
_SEND_CHUNK_MS = 20

_INT16_BYTES = 2
_PREAMBLE_TIMEOUT_S = 10.0

# The wire model caps ``WsRpcResponse.error`` at 512 characters and the
# server discards an oversized reply outright, stranding the tool call
# until its timeout. Bound every error here, the one place all paths cross.
_RPC_ERROR_MAX_CHARS = 512

# The agent's identity as this transport reports it. The socket is
# point-to-point, so the only thing that can invoke a client tool is the
# session's own server — there is no room full of participants to tell apart.
_AGENT_IDENTITY = "agent"


class WebSocketTransport:
    """Implements :class:`~cosmo_ai._internal.transport.Transport` over one
    websocket to a self-hosted ``cosmo-server``."""

    def __init__(self) -> None:
        self._socket: Any = None
        self._callbacks: TransportCallbacks | None = None
        self._reader: asyncio.Task[None] | None = None
        self._sender: asyncio.Task[None] | None = None
        self._rpc: dict[str, RpcHandler] = {}
        # Keyed by request id: a call the server withdraws has to be findable
        # to be stopped, and the handler is what carries the side effects.
        self._rpc_runs: dict[str, asyncio.Task[None]] = {}
        self._audio_sink: AgentAudioSink | None = None
        self._input_rate: int | None = None
        self._output_rate: int | None = None
        self._playback: Resampler | None = None
        self._published: PcmAudioSource | PcmMicSource | None = None
        self._echo: EchoCanceller | None = None
        self._closing = False

    # ── Lifecycle ──────────────────────────────────────────────────

    async def connect(
        self, started: StartedSession, callbacks: TransportCallbacks
    ) -> None:
        opened = _require_ws_start(started)
        websockets = _import_websockets()
        self._callbacks = callbacks
        try:
            self._socket = await websockets.connect(
                opened.ws_url,
                max_size=None,
                subprotocols=[opened.ws_subprotocol],
            )
            preamble = await asyncio.wait_for(
                self._socket.recv(), timeout=_PREAMBLE_TIMEOUT_S
            )
            if not isinstance(preamble, str):
                raise SessionStateError(code=SessionStateErrorCode.NOT_CONNECTED, message="websocket audio preamble was not text")
            self._adopt_audio_format(json.loads(preamble), required=True)
        except Exception as exc:
            if self._socket is not None:
                await self._socket.close()
            self._socket = None
            self._callbacks = None
            if isinstance(exc, SessionStateError):
                raise
            raise SessionStateError(code=SessionStateErrorCode.NOT_CONNECTED, message=f"websocket audio preamble failed: {exc}") from exc
        self._reader = asyncio.create_task(
            self._read(), name="cosmo-realtime-ws-reader"
        )

    def is_connected(self) -> bool:
        return self._socket is not None and not self._closing

    async def disconnect(self) -> None:
        self._closing = True
        await self._stop_audio_pump()
        reader, self._reader = self._reader, None
        socket, self._socket = self._socket, None
        self._callbacks = None
        self._audio_sink = None
        for task in self._rpc_runs.values():
            task.cancel()
        if socket is not None:
            try:
                await socket.close()
            except Exception:
                logger.exception("realtime.ws_close_failed", stack_info=True)
        if reader is not None:
            reader.cancel()
            try:
                await reader
            except asyncio.CancelledError:
                pass
            except Exception:
                # Cancelling a task that already failed re-raises its error
                # here. It is the only account of why the receive loop died.
                logger.warning("realtime.ws_reader_failed", exc_info=True)

    # ── Outbound ───────────────────────────────────────────────────

    async def send_frame(self, payload: bytes) -> None:
        await self._send_text(payload.decode("utf-8"))

    async def send_bytes(self, data: bytes, topic: str) -> None:
        raise SessionStateError(
            code=SessionStateErrorCode.NOT_CONNECTED,
            message=f"the websocket transport carries no byte streams (topic {topic!r})",
        )

    async def _send_text(self, raw: str) -> None:
        socket = self._socket
        if socket is None or self._closing:
            raise SessionStateError(code=SessionStateErrorCode.NOT_CONNECTED, message="the websocket session is not connected")
        await socket.send(raw)

    # ── Client tools ───────────────────────────────────────────────

    def register_rpc_method(self, name: str, handler: RpcHandler) -> None:
        # Registered before ``connect`` in the normal case; the reader task
        # does not exist yet, so nothing can race this.
        self._rpc[name] = handler

    def _forget_rpc_run(self, request_id: str) -> Any:
        def forget(_task: "asyncio.Task[None]") -> None:
            self._rpc_runs.pop(request_id, None)

        return forget

    async def _dispatch_rpc(self, request: dict[str, Any]) -> None:
        request_id = str(request.get("request_id", ""))
        method = str(request.get("method", ""))
        handler = self._rpc.get(method)
        if handler is None:
            await self._reply_rpc(request_id, error=f"no handler for {method!r}")
            return
        invocation = RpcInvocation(
            payload=str(request.get("payload", "{}")),
            caller_identity=_AGENT_IDENTITY,
            caller_is_agent=True,
        )
        try:
            payload = await handler(invocation)
        except asyncio.CancelledError:
            # Withdrawn while running. Nobody is waiting for a reply, and
            # sending one would answer a question already taken back.
            logger.info("realtime.client_tool_cancelled", tool=method)
            raise
        except RpcMethodError as exc:
            await self._reply_rpc(request_id, error=exc.message)
            return
        except Exception as exc:
            logger.exception("realtime.client_tool_failed", tool=method, stack_info=True)
            await self._reply_rpc(request_id, error=str(exc))
            return
        await self._reply_rpc(request_id, payload=payload)

    async def _reply_rpc(
        self, request_id: str, *, payload: str | None = None, error: str | None = None
    ) -> None:
        body: dict[str, Any] = {"type": WS_RPC_RESPONSE, "request_id": request_id}
        if payload is not None:
            body["payload"] = payload
        if error is not None:
            body["error"] = error[:_RPC_ERROR_MAX_CHARS]
        try:
            await self._send_text(json.dumps(body))
        except Exception:
            logger.info("realtime.rpc_reply_undeliverable", request_id=request_id)

    # ── Media ──────────────────────────────────────────────────────

    def create_mic_source(self, capture: Optional[MicrophoneCapture]) -> MicSource:
        return PcmMicSource(capture, sample_rate=self._require_input_rate())

    async def publish_audio_source(
        self, source: Any, *, track_name: str = "mic"
    ) -> Any:
        """Start pumping ``source``'s samples onto the socket.

        The handle returned is the source itself: there is no publication to
        name, so unpublishing is a matter of stopping the pump."""
        if not isinstance(source, (PcmAudioSource, PcmMicSource)):
            raise SessionStateError(
                code=SessionStateErrorCode.NOT_CONNECTED,
                message="the websocket transport publishes a PcmAudioSource (or the "
                "microphone); a livekit AudioSource has no readable samples",
            )
        if self._socket is None:
            raise SessionStateError(code=SessionStateErrorCode.NOT_CONNECTED, message="the websocket session is not connected")
        await self._stop_audio_pump()
        # Read once and hand the same value everywhere: a mid-session
        # ``ws-audio-format`` rewrite must not leave the canceller and the
        # pump chunking at different rates.
        input_rate = self._require_input_rate()
        if isinstance(source, PcmMicSource) and source.capture.echo_cancellation:
            try:
                self._echo = EchoCanceller(
                    capture_rate=input_rate,
                    playback_rate=AGENT_AUDIO_SAMPLE_RATE,
                )
            except ValueError:
                logger.warning(
                    "realtime.echo_cancellation_unavailable",
                    input_sample_rate=input_rate,
                )
        self._published = source
        queue = source.open_pcm_queue()
        sender = asyncio.create_task(
            self._pump_audio(
                queue, source_rate=source.sample_rate, input_rate=input_rate
            ),
            name="cosmo-realtime-ws-mic",
        )
        # A pump that dies on its own takes the session's voice with it and
        # nothing else would notice: the socket stays open and the microphone
        # simply stops arriving. Report it as a transport failure instead.
        sender.add_done_callback(self._on_sender_done)
        self._sender = sender
        return source

    def _on_sender_done(self, task: "asyncio.Task[None]") -> None:
        if task.cancelled() or self._closing:
            return
        error = task.exception()
        if error is None:
            return
        logger.error(
            "realtime.ws_audio_pump_failed",
            error=f"{type(error).__name__}: {error}",
        )
        callbacks = self._callbacks
        if callbacks is not None:
            callbacks.on_closed(
                TransportClose(
                    kind="transport_error",
                    detail=f"audio send failed: {type(error).__name__}: {error}",
                )
            )

    async def unpublish_track(self, publication: Any) -> None:
        if publication is not self._published:
            return
        await self._stop_audio_pump()

    def _disengage_echo(self, direction: str) -> None:
        """A faulted canceller must not take the call with it: drop back to
        the raw path and keep the audio flowing."""
        self._echo = None
        logger.exception(
            "realtime.echo_cancellation_disengaged",
            direction=direction,
            stack_info=True,
        )

    async def _stop_audio_pump(self) -> None:
        sender, self._sender = self._sender, None
        published, self._published = self._published, None
        self._echo = None
        if isinstance(published, PcmAudioSource):
            published.close()
        if sender is not None:
            sender.cancel()
            try:
                await sender
            except asyncio.CancelledError:
                pass
            except Exception:
                # Only reachable when the pump had already failed on its own;
                # this is a deliberate teardown, so the session has been told
                # by the done callback and there is nothing left to report.
                logger.debug("realtime.ws_audio_pump_failed", exc_info=True)

    async def _pump_audio(
        self, queue: "asyncio.Queue[bytes]", *, source_rate: int, input_rate: int
    ) -> None:
        """Drain captured PCM onto the socket at the provider's rate,
        echo-cancelled when a microphone publish engaged the canceller.

        The rate is re-read each time round rather than bound once, because
        ``ws-audio-format`` can arrive mid-session and ``_adopt_audio_format``
        rebuilds the playback resampler when it does. Binding it here left the
        two halves of the call on different rates: the agent's audio followed
        the new format while the microphone kept sending at the old one, with
        nothing raised. The TypeScript transport already reads its rate per
        chunk; this matches it.
        """
        rate = input_rate
        resample = Resampler(source_rate=source_rate, target_rate=rate)
        chunk_bytes = (rate * _SEND_CHUNK_MS // 1000) * _INT16_BYTES
        pending = bytearray()
        while True:
            data = await queue.get()

            current = self._input_rate or rate
            if current != rate:
                # Finish the old rate's audio before switching, or the tail
                # arrives mis-chunked at the new one.
                if pending:
                    await self._flush(pending, chunk_bytes)
                logger.debug(
                    "realtime.ws_capture_rate_changed", was=rate, now=current
                )
                rate = current
                resample = Resampler(source_rate=source_rate, target_rate=rate)
                chunk_bytes = (rate * _SEND_CHUNK_MS // 1000) * _INT16_BYTES
                self._rebuild_echo(rate)

            data = resample(data)
            if self._echo is not None:
                try:
                    data = self._echo.process_capture(data)
                except Exception:
                    self._disengage_echo("capture")
            pending.extend(data)
            if not await self._flush(pending, chunk_bytes):
                return

    async def _flush(self, pending: bytearray, chunk_bytes: int) -> bool:
        """Send whole chunks out of ``pending``. False once the socket is gone."""
        while len(pending) >= chunk_bytes:
            frame = bytes(pending[:chunk_bytes])
            del pending[:chunk_bytes]
            socket = self._socket
            if socket is None or self._closing:
                return False
            await socket.send(frame)
        return True

    def _rebuild_echo(self, capture_rate: int) -> None:
        """Re-make the canceller at a new capture rate, if one is engaged.

        It was built with the rate in force at publish time, so a format change
        leaves it cancelling against the wrong geometry.
        """
        if self._echo is None:
            return
        try:
            self._echo = EchoCanceller(
                capture_rate=capture_rate, playback_rate=AGENT_AUDIO_SAMPLE_RATE
            )
        except ValueError:
            self._echo = None
            logger.warning(
                "realtime.echo_cancellation_unavailable", input_sample_rate=capture_rate
            )

    def set_agent_audio_sink(self, sink: "AgentAudioSink | None") -> None:
        self._audio_sink = sink

    # ── Video and screen share ─────────────────────────────────────
    # Every start and push refuses; a stop or remove for a publish that can
    # never exist keeps its idempotent no-op contract.

    async def start_screen_share(self, *, width: int, height: int) -> None:
        raise _video_unsupported()

    def push_screen_share_frame(self, frame: Any) -> None:
        raise _video_unsupported()

    async def stop_screen_share(self) -> None:
        return None

    async def add_video_stream(self, *, width: int, height: int) -> str:
        raise _video_unsupported()

    def push_video_frame(self, stream_id: str, frame: Any) -> None:
        raise _video_unsupported()

    async def remove_video_stream(self, stream_id: str) -> None:
        return None

    # ── Inbound ────────────────────────────────────────────────────

    async def _read(self) -> None:
        socket = self._socket
        assert socket is not None
        close = TransportClose(kind="transport_error", detail=None)
        try:
            async for message in socket:
                if isinstance(message, bytes):
                    self._on_audio(message)
                else:
                    self._on_text(message)
            # Iteration ends here only on a clean close; any other code
            # raises ConnectionClosed below.
            close = TransportClose(
                kind="server_ended", detail=socket.close_reason or "socket closed"
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            close = TransportClose(
                kind="transport_error", detail=_read_failure_detail(exc)
            )
            logger.info("realtime.ws_read_ended", detail=close.detail)
        if self._closing:
            return
        callbacks = self._callbacks
        if callbacks is not None:
            callbacks.on_closed(close)

    def _on_text(self, raw: str) -> None:
        try:
            decoded = json.loads(raw)
        except ValueError:
            # Not ours to drop: the session turns an undecodable frame into
            # an UnknownEvent and keeps iterating, and that contract is the
            # same on both transports.
            logger.warning("realtime.ws_frame_undecodable")
            self._forward(raw)
            return
        kind = decoded.get("type") if isinstance(decoded, dict) else None
        if kind == WS_AUDIO_FORMAT:
            self._adopt_audio_format(decoded, required=False)
            return
        if kind == WS_RPC_REQUEST:
            request_id = str(decoded.get("request_id", ""))
            run = asyncio.create_task(self._dispatch_rpc(decoded))
            self._rpc_runs[request_id] = run
            run.add_done_callback(self._forget_rpc_run(request_id))
            return
        if kind == WS_RPC_CANCEL:
            # The call was withdrawn — the user interrupted the turn that
            # asked for it. Stopping the handler is the point; its result is
            # already unwanted.
            withdrawn = self._rpc_runs.pop(str(decoded.get("request_id", "")), None)
            if withdrawn is not None and not withdrawn.done():
                withdrawn.cancel()
            return
        self._forward(raw)

    def _forward(self, raw: str) -> None:
        """Hand one frame to the session exactly as it arrived."""
        callbacks = self._callbacks
        if callbacks is not None:
            callbacks.on_frame(raw.encode("utf-8"))

    def _adopt_audio_format(self, frame: dict[str, Any], *, required: bool) -> None:
        if frame.get("type") != WS_AUDIO_FORMAT:
            if required:
                raise SessionStateError(code=SessionStateErrorCode.NOT_CONNECTED, message="websocket audio preamble was missing")
            return
        try:
            input_rate = int(frame["input_sample_rate_hz"])
            output_rate = int(frame["output_sample_rate_hz"])
            channels = int(frame["num_channels"])
        except (KeyError, TypeError, ValueError) as exc:
            raise SessionStateError(code=SessionStateErrorCode.NOT_CONNECTED, message="websocket audio preamble was malformed") from exc
        if input_rate <= 0 or output_rate <= 0 or channels != 1:
            raise SessionStateError(code=SessionStateErrorCode.NOT_CONNECTED, message="websocket audio preamble has unsupported geometry")
        self._input_rate = input_rate
        self._output_rate = output_rate
        self._playback = Resampler(
            source_rate=output_rate, target_rate=AGENT_AUDIO_SAMPLE_RATE
        )
        logger.debug(
            "realtime.ws_audio_format",
            input_sample_rate=self._input_rate,
            output_sample_rate=self._output_rate,
        )

    def _on_audio(self, data: bytes) -> None:
        sink = self._audio_sink
        if sink is None or not data:
            return
        if self._playback is None:
            self._playback = Resampler(
                source_rate=self._require_output_rate(),
                target_rate=AGENT_AUDIO_SAMPLE_RATE,
            )
        samples = self._playback(data)
        if not samples:
            return
        if self._echo is not None:
            try:
                self._echo.analyze_playback(samples)
            except Exception:
                self._disengage_echo("playback")
        sink.deliver(
            AgentAudioFrame(
                data=samples,
                sample_rate=AGENT_AUDIO_SAMPLE_RATE,
                num_channels=1,
                samples_per_channel=len(samples) // _INT16_BYTES,
            )
        )

    def _require_input_rate(self) -> int:
        if self._input_rate is None:
            raise SessionStateError(code=SessionStateErrorCode.NOT_CONNECTED, message="websocket audio preamble has not arrived")
        return self._input_rate

    def _require_output_rate(self) -> int:
        if self._output_rate is None:
            raise SessionStateError(code=SessionStateErrorCode.NOT_CONNECTED, message="websocket audio preamble has not arrived")
        return self._output_rate


def _video_unsupported() -> SessionStartError:
    return SessionStartError(
        code=SessionStartErrorCode.CONFIG,
        server_code="video_unsupported",
        message=(
            "the websocket transport carries no video; run the server on its "
            "WebRTC transport for camera or screen input"
        ),
    )


def _require_ws_start(started: StartedSession) -> WsSessionStart:
    if not isinstance(started, WsSessionStart):
        raise SessionStateError(
            code=SessionStateErrorCode.NOT_CONNECTED,
            message="the session start did not answer a websocket URL; the server is "
            "not running COSMO_TRANSPORT=websocket",
        )
    return started


def _read_failure_detail(exc: Exception) -> str:
    from websockets.exceptions import ConnectionClosed

    if isinstance(exc, ConnectionClosed):
        if exc.rcvd is None:
            return "closed without a close frame (1006)"
        detail = f"closed by the server ({exc.rcvd.code})"
        if exc.rcvd.reason:
            detail = f"{detail}: {exc.rcvd.reason}"
        return detail
    return f"{type(exc).__name__}: {exc}"


def _import_websockets() -> Any:
    try:
        import websockets.asyncio.client as client
    except ImportError as exc:  # pragma: no cover - packaging guard
        raise SessionStateError(
            code=SessionStateErrorCode.NOT_CONNECTED,
            message="the websocket transport needs the 'websockets' package; install "
            "cosmo-ai-sdk[websocket]",
        ) from exc
    return client
