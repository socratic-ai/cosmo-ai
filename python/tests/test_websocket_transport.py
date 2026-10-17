"""The websocket transport against a fake socket: what the session sees.

The session above this transport is the same session the LiveKit lane runs,
so what is worth pinning here is only what differs — the audio geometry, the
RPC frame pair, and what happens when the socket goes away.
"""

from __future__ import annotations

import asyncio
import json
import math
from array import array
from typing import Any

import pytest

from cosmo_ai import SessionStartErrorCode

from cosmo_ai._internal.protocol import (
    BackgroundClientTool,
    SessionResponse,
    WsSessionStart,
)
from cosmo_ai._internal.transport import (
    RpcInvocation,
    RpcMethodError,
    TransportCallbacks,
    TransportClose,
)
from cosmo_ai.audio import AGENT_AUDIO_SAMPLE_RATE, AgentAudioFrame
from cosmo_ai.audio._pcm import PcmAudioSource, Resampler, mono_pcm16
from cosmo_ai.errors import SessionStateError, SessionStartError
from cosmo_ai.session._websocket import WebSocketTransport
from cosmo_ai.tools import ClientToolJob

from .fakes import start_fake_session

STARTED = WsSessionStart(
    session_id="s-1",
    ws_url="ws://localhost:8080/connect",
    ws_subprotocol="one-time-connect-capability",
)

AUDIO_FORMAT = json.dumps(
    {
        "type": "ws-audio-format",
        "input_sample_rate_hz": 16000,
        "output_sample_rate_hz": 24000,
        "num_channels": 1,
    }
)


class FakeSocket:
    """One socket: a scripted inbound feed and a record of what went out."""

    def __init__(self, inbound: list[Any] | None = None) -> None:
        self.sent: list[Any] = []
        self.closed = False
        self.close_code: int | None = None
        self.close_reason: str | None = None
        self._inbound: asyncio.Queue[Any] = asyncio.Queue()
        for message in inbound or []:
            self._inbound.put_nowait(message)

    def push(self, message: Any) -> None:
        self._inbound.put_nowait(message)

    async def send(self, message: Any) -> None:
        self.sent.append(message)

    async def close(self) -> None:
        self.closed = True

    async def recv(self) -> Any:
        return await self._inbound.get()

    def __aiter__(self) -> "FakeSocket":
        return self

    async def __anext__(self) -> Any:
        return await self._inbound.get()

    def text_frames(self) -> list[dict[str, Any]]:
        return [json.loads(m) for m in self.sent if isinstance(m, str)]

    def binary_frames(self) -> list[bytes]:
        return [m for m in self.sent if isinstance(m, bytes)]


class Recorder:
    def __init__(self) -> None:
        self.frames: list[bytes] = []
        self.closes: list[TransportClose] = []
        self.audio: list[AgentAudioFrame] = []

    def callbacks(self) -> TransportCallbacks:
        return TransportCallbacks(
            on_frame=self.frames.append,
            on_closed=self.closes.append,
            on_reconnecting=lambda: None,
            on_reconnected=lambda: None,
        )

    def deliver(self, frame: AgentAudioFrame) -> None:
        self.audio.append(frame)


class Frame:
    """A caller-owned PCM frame, the shape ``capture_frame`` accepts."""

    def __init__(self, data: bytes, sample_rate: int, num_channels: int = 1) -> None:
        self.data = data
        self.sample_rate = sample_rate
        self.num_channels = num_channels


async def connected(
    socket: FakeSocket, recorder: Recorder, monkeypatch: pytest.MonkeyPatch
) -> WebSocketTransport:
    transport = WebSocketTransport()

    async def fake_connect(url: str, **kwargs: Any) -> FakeSocket:
        assert url == STARTED.ws_url
        assert kwargs["subprotocols"] == [STARTED.ws_subprotocol]
        assert "additional_headers" not in kwargs
        return socket

    monkeypatch.setattr(
        "cosmo_ai.session._websocket._import_websockets",
        lambda: type("client", (), {"connect": staticmethod(fake_connect)}),
    )
    await transport.connect(STARTED, recorder.callbacks())
    return transport


async def settle() -> None:
    """Let the reader task drain what the socket already holds."""
    for _ in range(6):
        await asyncio.sleep(0)


def test_a_livekit_start_has_no_socket_to_open() -> None:
    async def scenario() -> None:
        transport = WebSocketTransport()
        started = SessionResponse(
            livekit_url="ws://lk", token="t", room_name="r", session_id="s"
        )
        with pytest.raises(SessionStateError):
            await transport.connect(started, Recorder().callbacks())

    asyncio.run(scenario())


def test_session_frames_reach_the_session_and_ours_do_not(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def scenario() -> None:
        socket = FakeSocket(
            [AUDIO_FORMAT, json.dumps({"type": "ready", "session_id": "s-1"})]
        )
        recorder = Recorder()
        transport = await connected(socket, recorder, monkeypatch)
        await settle()
        # ``ws-audio-format`` is the transport's own; only ``ready`` is the
        # session's to decode.
        assert [json.loads(f)["type"] for f in recorder.frames] == ["ready"]
        await transport.disconnect()

    asyncio.run(scenario())


def test_connect_waits_for_the_authenticated_audio_preamble(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def scenario() -> None:
        socket = FakeSocket([json.dumps({"type": "ready", "session_id": "s-1"})])
        with pytest.raises(SessionStateError, match="audio preamble"):
            await connected(socket, Recorder(), monkeypatch)
        assert socket.closed is True

    asyncio.run(scenario())


def test_agent_audio_arrives_at_the_sdk_decoded_geometry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def scenario() -> None:
        socket = FakeSocket([AUDIO_FORMAT])
        recorder = Recorder()
        transport = await connected(socket, recorder, monkeypatch)
        transport.set_agent_audio_sink(recorder)
        await settle()
        # A tenth of a second at the provider's 24 kHz.
        socket.push(b"\x00\x10" * 2400)
        await settle()
        assert len(recorder.audio) == 1
        frame = recorder.audio[0]
        assert frame.sample_rate == AGENT_AUDIO_SAMPLE_RATE
        assert frame.num_channels == 1
        # Resampled 24k -> 48k, so twice the samples, give or take the seam.
        assert abs(frame.samples_per_channel - 4800) <= 2
        assert frame.samples_per_channel == len(frame.data) // 2
        await transport.disconnect()

    asyncio.run(scenario())


def test_published_audio_is_resampled_to_what_the_server_asked_for(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def scenario() -> None:
        socket = FakeSocket([AUDIO_FORMAT])
        recorder = Recorder()
        transport = await connected(socket, recorder, monkeypatch)
        await settle()
        source = PcmAudioSource(48000, 1)
        await transport.publish_audio_source(source)
        # A quarter second at 48 kHz, in 20 ms frames.
        for _ in range(12):
            await source.capture_frame(Frame(b"\x00\x08" * 960, 48000))
        await settle()
        sent = b"".join(socket.binary_frames())
        # 240 ms at 48 kHz becomes 240 ms at 16 kHz: a third of the samples.
        assert 0 < len(sent) <= 12 * 960 * 2 // 3
        assert len(sent) % 2 == 0
        await transport.disconnect()

    asyncio.run(scenario())


def test_a_livekit_audio_source_is_refused_with_the_reason(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def scenario() -> None:
        socket = FakeSocket([AUDIO_FORMAT])
        transport = await connected(socket, Recorder(), monkeypatch)
        with pytest.raises(SessionStateError, match="PcmAudioSource"):
            await transport.publish_audio_source(object())
        await transport.disconnect()

    asyncio.run(scenario())


def test_a_client_tool_call_is_answered_on_the_same_socket(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def scenario() -> None:
        socket = FakeSocket([AUDIO_FORMAT])
        transport = await connected(socket, Recorder(), monkeypatch)

        seen: list[RpcInvocation] = []

        async def handler(invocation: RpcInvocation) -> str:
            seen.append(invocation)
            return json.dumps({"ok": True, "result": {"time": "12:00"}})

        transport.register_rpc_method("get_time", handler)
        socket.push(
            json.dumps(
                {
                    "type": "rpc-request",
                    "request_id": "r-1",
                    "method": "get_time",
                    "payload": json.dumps({"tz": "utc"}),
                }
            )
        )
        await settle()
        assert seen[0].payload == json.dumps({"tz": "utc"})
        # The socket is point to point, so its one peer is the agent and the
        # runtime's agent-only guard has nothing else it could be.
        assert seen[0].caller_is_agent is True
        reply = socket.text_frames()[-1]
        assert reply["request_id"] == "r-1"
        assert json.loads(reply["payload"])["result"] == {"time": "12:00"}
        await transport.disconnect()

    asyncio.run(scenario())


@pytest.mark.parametrize(
    ("method", "raises", "expected"),
    [
        ("get_time", RpcMethodError(code=7, message="not allowed"), "not allowed"),
        ("get_time", RuntimeError("handler blew up"), "handler blew up"),
        ("nope", None, "no handler"),
    ],
    ids=["rejected", "raised", "unknown"],
)
def test_a_call_that_cannot_run_is_answered_with_an_error(
    method: str,
    raises: Exception | None,
    expected: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def scenario() -> None:
        socket = FakeSocket([AUDIO_FORMAT])
        transport = await connected(socket, Recorder(), monkeypatch)

        async def handler(invocation: RpcInvocation) -> str:
            assert raises is not None
            raise raises

        transport.register_rpc_method("get_time", handler)
        socket.push(
            json.dumps(
                {
                    "type": "rpc-request",
                    "request_id": "r-1",
                    "method": method,
                    "payload": "{}",
                }
            )
        )
        await settle()
        reply = socket.text_frames()[-1]
        assert reply["request_id"] == "r-1"
        assert expected in reply["error"]
        assert "payload" not in reply
        await transport.disconnect()

    asyncio.run(scenario())


def test_a_socket_that_closes_ends_the_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def scenario() -> None:
        socket = FakeSocket([AUDIO_FORMAT])
        recorder = Recorder()
        transport = await connected(socket, recorder, monkeypatch)
        await settle()

        async def stop() -> Any:
            raise StopAsyncIteration

        monkeypatch.setattr(FakeSocket, "__anext__", lambda self: stop())
        socket.push("wake the reader")
        await settle()
        assert [close.kind for close in recorder.closes] == ["server_ended"]
        await transport.disconnect()

    asyncio.run(scenario())


def test_a_clean_close_carries_the_servers_reason(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def scenario() -> None:
        socket = FakeSocket([AUDIO_FORMAT])
        recorder = Recorder()
        transport = await connected(socket, recorder, monkeypatch)
        await settle()
        socket.close_code = 1000
        socket.close_reason = "conversation complete"

        async def stop() -> Any:
            raise StopAsyncIteration

        monkeypatch.setattr(FakeSocket, "__anext__", lambda self: stop())
        socket.push("wake the reader")
        await settle()
        assert [(c.kind, c.detail) for c in recorder.closes] == [
            ("server_ended", "conversation complete")
        ]
        await transport.disconnect()

    asyncio.run(scenario())


def test_a_policy_close_names_the_code_and_the_reason(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A 1008 is the server refusing the connection on purpose; the raw
    ``ConnectionClosedError`` repr hides both the code and its reason."""
    from websockets.exceptions import ConnectionClosedError
    from websockets.frames import Close

    async def scenario() -> None:
        socket = FakeSocket([AUDIO_FORMAT])
        recorder = Recorder()
        transport = await connected(socket, recorder, monkeypatch)
        await settle()

        async def refuse() -> Any:
            raise ConnectionClosedError(
                rcvd=Close(1008, "browser origin must be loopback"),
                sent=Close(1008, ""),
                rcvd_then_sent=True,
            )

        monkeypatch.setattr(FakeSocket, "__anext__", lambda self: refuse())
        socket.push("wake the reader")
        await settle()
        assert [c.kind for c in recorder.closes] == ["transport_error"]
        assert (
            recorder.closes[0].detail
            == "closed by the server (1008): browser origin must be loopback"
        )
        await transport.disconnect()

    asyncio.run(scenario())


def test_an_oversized_rpc_error_is_capped_to_what_the_server_accepts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The wire model caps ``error`` at 512 characters and the server
    discards an oversized reply, stranding the call until its timeout."""

    async def scenario() -> None:
        socket = FakeSocket([AUDIO_FORMAT])
        transport = await connected(socket, Recorder(), monkeypatch)

        async def handler(invocation: RpcInvocation) -> str:
            raise RuntimeError("x" * 600)

        transport.register_rpc_method("get_time", handler)
        socket.push(
            json.dumps(
                {
                    "type": "rpc-request",
                    "request_id": "r-1",
                    "method": "get_time",
                    "payload": "{}",
                }
            )
        )
        await settle()
        reply = socket.text_frames()[-1]
        assert reply["request_id"] == "r-1"
        assert reply["error"] == "x" * 512
        await transport.disconnect()

    asyncio.run(scenario())


def test_disconnecting_does_not_report_a_close(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def scenario() -> None:
        socket = FakeSocket([AUDIO_FORMAT])
        recorder = Recorder()
        transport = await connected(socket, recorder, monkeypatch)
        await settle()
        await transport.disconnect()
        await settle()
        assert recorder.closes == []
        assert socket.closed is True
        assert transport.is_connected() is False

    asyncio.run(scenario())


def test_every_video_call_is_refused_with_one_code() -> None:
    """Video was the silent no-op on this transport. Every start and push now
    refuses the way the background-tools guard does — the session-start error
    family carrying the one stable code — whatever the connection state."""
    transport = WebSocketTransport()

    async def scenario() -> None:
        with pytest.raises(SessionStartError) as share:
            await transport.start_screen_share(width=1920, height=1080)
        assert share.value.code is SessionStartErrorCode.CONFIG
        assert share.value.server_code == "video_unsupported"
        with pytest.raises(SessionStartError) as stream:
            await transport.add_video_stream(width=640, height=480)
        assert stream.value.code is SessionStartErrorCode.CONFIG
        assert stream.value.server_code == "video_unsupported"

    asyncio.run(scenario())
    with pytest.raises(SessionStartError) as share_frame:
        transport.push_screen_share_frame(object())
    assert share_frame.value.code is SessionStartErrorCode.CONFIG
    assert share_frame.value.server_code == "video_unsupported"
    with pytest.raises(SessionStartError) as stream_frame:
        transport.push_video_frame("video.input.default", object())
    assert stream_frame.value.code is SessionStartErrorCode.CONFIG
    assert stream_frame.value.server_code == "video_unsupported"


def test_a_stop_for_video_that_could_never_start_stays_a_no_op(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """stop/remove keep their idempotent contract: the corresponding starts
    refuse, so teardown code shared with the WebRTC lane must not blow up
    here — and nothing goes on the wire for a publish that never existed."""

    async def scenario() -> None:
        socket = FakeSocket([AUDIO_FORMAT])
        transport = await connected(socket, Recorder(), monkeypatch)
        await transport.stop_screen_share()
        await transport.remove_video_stream("video.input.default")
        assert socket.sent == []
        await transport.disconnect()

    asyncio.run(scenario())


@pytest.mark.parametrize(
    ("source_rate", "target_rate"), [(48000, 16000), (24000, 48000), (44100, 16000)]
)
def test_resampling_keeps_the_signal_and_the_duration(
    source_rate: int, target_rate: int
) -> None:
    seconds = 0.5
    hz = 440.0
    source = array(
        "h",
        (
            int(12000 * math.sin(2 * math.pi * hz * i / source_rate))
            for i in range(int(source_rate * seconds))
        ),
    ).tobytes()
    resample = Resampler(source_rate=source_rate, target_rate=target_rate)
    chunk = source_rate * 2 // 50  # 20 ms
    out = b"".join(
        resample(source[i : i + chunk]) for i in range(0, len(source), chunk)
    )
    got = array("h")
    got.frombytes(out)
    # Duration is preserved to within a sample of the seam.
    assert abs(len(got) - int(target_rate * seconds)) <= 2
    ideal = [
        12000 * math.sin(2 * math.pi * hz * i / target_rate) for i in range(len(got))
    ]
    # Linear interpolation on a speech-band tone: a few percent of full scale.
    worst = max(abs(got[i] - ideal[i]) for i in range(10, len(got) - 10))
    assert worst < 12000 * 0.05


def test_resampling_between_equal_rates_is_a_passthrough() -> None:
    resample = Resampler(source_rate=16000, target_rate=16000)
    assert resample(b"\x01\x02\x03\x04") == b"\x01\x02\x03\x04"


def test_extra_channels_are_mixed_down_before_they_are_sent() -> None:
    stereo = array("h", [100, 300, -200, 0]).tobytes()
    assert mono_pcm16(Frame(stereo, 16000, 2)) == array("h", [200, -100]).tobytes()


# ── The websocket session start (the client half) ──────────────────

WS_START_URL = "https://api.test/api/v1/external/realtime/session/ws-start"


def _ws_client(handler: Any, *, token: Any = None) -> Any:
    import httpx

    from cosmo_ai import RealtimeClient

    return RealtimeClient(
        api_key=None if token is not None else "sk-secret",
        token=token,
        transport="websocket",
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )


def _config() -> Any:
    from cosmo_ai._internal.protocol import InlineAgentConfig, SessionConfig, _sdk_info

    return SessionConfig(sdk=_sdk_info(), agent=InlineAgentConfig(instructions="hi"))


def test_the_websocket_start_posts_its_own_route() -> None:
    import httpx

    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        return httpx.Response(
            200,
            json={
                "session_id": "s-1",
                "ws_url": "ws://localhost:8080/connect",
                "ws_subprotocol": "one-time-connect-capability",
            },
        )

    async def scenario() -> Any:
        return await _ws_client(handler)._start_session(_config())

    started = asyncio.run(scenario())
    assert seen["url"] == WS_START_URL
    assert (started.session_id, started.ws_url) == ("s-1", "ws://localhost:8080/connect")


def test_a_server_without_the_route_says_which_transport_it_runs() -> None:
    import httpx

    from cosmo_ai.errors import SessionStartError

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"detail": "Not Found"})

    async def scenario() -> None:
        await _ws_client(handler)._start_session(_config())

    with pytest.raises(SessionStartError) as caught:
        asyncio.run(scenario())
    assert caught.value.code is SessionStartErrorCode.CONFIG
    assert "COSMO_TRANSPORT=websocket" in caught.value.message


def test_a_malformed_start_response_is_a_typed_rejection() -> None:
    """The room path normalizes this; the socket path has to as well, or
    ``_start`` never runs its abort bookkeeping and the session stays
    CONNECTING."""
    import httpx

    from cosmo_ai.errors import SessionStartError

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"session_id": "s-1"})  # no ws_url

    async def scenario() -> None:
        await _ws_client(handler)._start_session(_config())

    with pytest.raises(SessionStartError) as caught:
        asyncio.run(scenario())
    assert caught.value.code is SessionStartErrorCode.INVALID_RESPONSE


def test_a_rejected_token_is_dropped_so_the_next_start_refetches() -> None:
    """A self-hosted server mints a signing key at startup, so a restart
    rejects every token minted before it — a cached one must not be reused
    until its natural expiry."""
    import httpx

    from cosmo_ai import TokenSource
    from cosmo_ai.errors import SessionStartError

    fetches = 0

    async def fetch() -> Any:
        nonlocal fetches
        fetches += 1
        from cosmo_ai._internal.protocol import MintedToken

        return MintedToken(
            jwt=f"jwt-{fetches}",
            expires_at=__import__("datetime").datetime.now(
                __import__("datetime").timezone.utc
            )
            + __import__("datetime").timedelta(hours=1),
        )

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": {"type": "api_error", "message": "no"}})

    async def scenario() -> None:
        client = _ws_client(handler, token=TokenSource.custom(fetch))
        for _ in range(2):
            with pytest.raises(SessionStartError):
                await client._start_session(_config())

    asyncio.run(scenario())
    # Without the invalidation the second start reuses the cached token and
    # never refetches.
    assert fetches == 2


# ── PcmAudioSource on the room transport ───────────────────────────


def test_a_structural_frame_is_rebuilt_for_the_room_transport() -> None:
    """``PcmFrame`` promises any object carrying the three fields works, and
    the source publishes on either transport — but WebRTC's capture reaches
    for ``samples_per_channel`` and a protobuf view, so the structural frame
    has to be rebuilt on the way in."""
    from livekit import rtc

    captured: list[Any] = []

    class FakeLiveKitSource:
        async def capture_frame(self, frame: Any) -> None:
            captured.append(frame)

    async def scenario() -> None:
        source = PcmAudioSource(48000, 1)
        source._livekit_source = FakeLiveKitSource()
        await source.capture_frame(Frame(b"\x01\x02" * 480, 48000))

    asyncio.run(scenario())
    assert isinstance(captured[0], rtc.AudioFrame)
    assert captured[0].samples_per_channel == 480
    assert captured[0].sample_rate == 48000


def test_a_livekit_frame_passes_through_untouched() -> None:
    from livekit import rtc

    captured: list[Any] = []

    class FakeLiveKitSource:
        async def capture_frame(self, frame: Any) -> None:
            captured.append(frame)

    async def scenario() -> None:
        source = PcmAudioSource(48000, 1)
        source._livekit_source = FakeLiveKitSource()
        frame = rtc.AudioFrame(b"\x01\x02" * 480, 48000, 1, 480)
        await source.capture_frame(frame)
        assert captured[0] is frame

    asyncio.run(scenario())


# ── The microphone's device handle ─────────────────────────────────


def test_a_microphone_that_opens_but_will_not_start_releases_the_device(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``start`` can fail on a stream that opened. It is not reachable from
    ``stop`` yet, so leaving it open would keep the device allocated and make
    the retry fail too."""
    from cosmo_ai.audio import _pcm, _sounddevice
    from cosmo_ai.errors import AudioUnavailableError

    closed: list[bool] = []

    class FakeStream:
        def start(self) -> None:
            raise RuntimeError("device busy")

        def close(self) -> None:
            closed.append(True)

    monkeypatch.setattr(
        _sounddevice,
        "ensure_sounddevice",
        lambda: type("sd", (), {"RawInputStream": lambda **kw: FakeStream()}),
    )

    async def scenario() -> None:
        mic = _pcm.PcmMicSource(sample_rate=16000)
        with pytest.raises(AudioUnavailableError):
            await mic.start()

    asyncio.run(scenario())
    assert closed == [True]


@pytest.mark.parametrize(
    ("sample_rate", "num_channels"), [(0, 1), (-8000, 1), (48000, 0)]
)
def test_an_impossible_geometry_is_refused_at_construction(
    sample_rate: int, num_channels: int
) -> None:
    """A zero rate makes the resample step zero, so the read position never
    advances and the loop appends forever — inside a background sender, where
    it takes the whole event loop with it and raises nowhere the caller can
    see. It has to fail here instead."""
    with pytest.raises(ValueError):
        PcmAudioSource(sample_rate, num_channels)


@pytest.mark.parametrize(("source_rate", "target_rate"), [(0, 16000), (16000, 0)])
def test_the_resampler_refuses_an_impossible_conversion(
    source_rate: int, target_rate: int
) -> None:
    with pytest.raises(ValueError):
        Resampler(source_rate=source_rate, target_rate=target_rate)


@pytest.mark.parametrize("name", ["websockets", "livekit ", "WEBSOCKET ", "grpc", ""])
def test_an_unrecognized_transport_name_is_refused(
    name: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Everything that is not exactly "websocket" runs the room lane, so a
    typo would post to the wrong endpoint and read as a server problem."""
    from cosmo_ai import RealtimeClient

    monkeypatch.delenv("COSMO_TRANSPORT", raising=False)
    with pytest.raises(ValueError, match="webrtc or websocket"):
        RealtimeClient(api_key="sk", transport=name)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("given", "expected"), [("websocket", "websocket"), ("webrtc", "webrtc")]
)
def test_the_two_transport_names_resolve(
    given: str, expected: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    from cosmo_ai import RealtimeClient

    monkeypatch.delenv("COSMO_TRANSPORT", raising=False)
    assert RealtimeClient(api_key="sk", transport=given)._transport == expected  # type: ignore[arg-type]


def test_livekit_is_a_deprecated_alias_for_webrtc(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from cosmo_ai import RealtimeClient

    monkeypatch.delenv("COSMO_TRANSPORT", raising=False)
    with pytest.warns(DeprecationWarning, match="use transport='webrtc'") as caught:
        client = RealtimeClient(api_key="sk", transport="livekit")
    assert client._transport == "webrtc"
    assert caught[0].filename == __file__


def test_an_audio_pump_that_dies_reports_a_transport_close(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A dead sender takes the session's voice with it, and nothing else
    notices: the socket stays open and the microphone stops arriving."""

    async def scenario() -> None:
        socket = FakeSocket([AUDIO_FORMAT])
        recorder = Recorder()
        transport = await connected(socket, recorder, monkeypatch)
        await settle()
        source = PcmAudioSource(16000, 1)
        await transport.publish_audio_source(source)

        async def explode(*_a: Any, **_k: Any) -> None:
            raise RuntimeError("socket went away")

        monkeypatch.setattr(socket, "send", explode)
        await source.capture_frame(Frame(b"\x00\x01" * 320, 16000))
        await settle()
        assert [c.kind for c in recorder.closes] == ["transport_error"]
        assert "socket went away" in (recorder.closes[0].detail or "")
        await transport.disconnect()

    asyncio.run(scenario())


def test_a_reused_source_follows_the_transport_it_is_publishing_on() -> None:
    """A source that published in a room keeps its WebRTC source cached.
    Reused on a later socket session it would otherwise keep feeding the room
    nobody is in, and send the socket silence."""
    room_frames: list[Any] = []

    class FakeLiveKitSource:
        async def capture_frame(self, frame: Any) -> None:
            room_frames.append(frame)

    async def scenario() -> None:
        source = PcmAudioSource(16000, 1)
        source._livekit_source = FakeLiveKitSource()
        await source.capture_frame(Frame(b"\x01\x02" * 160, 16000))
        assert len(room_frames) == 1

        # A later session on the socket transport opens the PCM queue.
        queue = source.open_pcm_queue()
        await source.capture_frame(Frame(b"\x03\x04" * 160, 16000))
        assert queue.qsize() == 1, "the frame went to the room, not the socket"
        assert len(room_frames) == 1, "the stale room source was still fed"

    asyncio.run(scenario())


def test_a_withdrawn_call_stops_the_handler(monkeypatch: pytest.MonkeyPatch) -> None:
    """The handler is what carries the side effect. A call the server
    withdraws has to stop running, not merely have its answer discarded."""

    async def scenario() -> None:
        socket = FakeSocket([AUDIO_FORMAT])
        transport = await connected(socket, Recorder(), monkeypatch)
        started = asyncio.Event()
        finished: list[str] = []

        async def slow(invocation: RpcInvocation) -> str:
            started.set()
            # Short enough that the wait below outlives it: uncancelled, the
            # side effect lands and the assertion sees it.
            await asyncio.sleep(0.3)
            finished.append("side effect happened")
            return json.dumps({"ok": True, "result": {}})

        transport.register_rpc_method("slow_tool", slow)
        socket.push(
            json.dumps(
                {
                    "type": "rpc-request",
                    "request_id": "r-1",
                    "method": "slow_tool",
                    "payload": "{}",
                }
            )
        )
        await settle()
        assert started.is_set()
        socket.push(json.dumps({"type": "rpc-cancel", "request_id": "r-1"}))
        await settle()
        await asyncio.sleep(0.6)  # past where the handler would have finished
        assert finished == [], "the withdrawn handler ran to completion"
        # And nothing was answered for a call nobody is waiting on.
        assert [f for f in socket.text_frames() if f.get("request_id") == "r-1"] == []
        await transport.disconnect()

    asyncio.run(scenario())


def test_a_background_tool_is_refused_on_this_transport() -> None:
    """A background handler acks and keeps working on its own task, so this
    lane cannot stop it once started. Refusing the session means the side
    effect never begins, instead of running while the model is told it
    failed."""
    import httpx

    from cosmo_ai import RealtimeClient
    from cosmo_ai._internal.protocol import BackgroundClientTool
    from cosmo_ai.errors import SessionStartError

    async def work(args: dict[str, Any], job: Any) -> None:
        await job.ack("started")

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("the session must not even start")

    async def scenario() -> None:
        client = RealtimeClient(
            api_key="sk",
            transport="websocket",
            http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        )
        agent = client.agent(
            instructions="hi",
            tools=[
                BackgroundClientTool(
                    name="slow_job",
                    description="Slow.",
                    parameters={"type": "object", "properties": {}},
                    handler=work,
                )
            ],
        )
        await agent.start()

    with pytest.raises(SessionStartError) as caught:
        asyncio.run(scenario())
    assert caught.value.code is SessionStartErrorCode.CONFIG
    assert caught.value.server_code == "background_tools_unsupported"
    assert "slow_job" in caught.value.message


def test_a_background_tool_starts_on_the_default_transport() -> None:
    async def work(args: dict[str, Any], job: ClientToolJob) -> None:
        await job.ack("started")

    async def scenario() -> None:
        harness = await start_fake_session(
            tools=[
                BackgroundClientTool(
                    name="slow_job",
                    description="Slow.",
                    parameters={"type": "object", "properties": {}},
                    handler=work,
                )
            ],
        )
        assert "slow_job" in harness.transport.rpc_methods
        assert [spec["name"] for spec in harness.start_bodies[0]["agent"]["tools"]] == [
            "slow_job"
        ]

    asyncio.run(scenario())


def test_the_room_transport_closes_the_source_it_built() -> None:
    """A PcmAudioSource publishes through a WebRTC source this SDK creates.
    It holds a native handle and its own queue, so unpublishing has to close
    it — a caller-supplied rtc.AudioSource is never wrapped and never
    touched."""
    from cosmo_ai.session._livekit import LiveKitTransport

    closed: list[bool] = []

    class FakeInner:
        async def aclose(self) -> None:
            closed.append(True)

        async def capture_frame(self, frame: Any) -> None:
            return None

    class FakePublication:
        sid = "pub-1"

    class FakeParticipant:
        async def unpublish_track(self, sid: str) -> None:
            return None

    class FakeRoom:
        local_participant = FakeParticipant()

    async def scenario() -> None:
        transport = LiveKitTransport()
        source = PcmAudioSource(48000, 1)
        source._livekit_source = FakeInner()
        transport._owned_source = source
        transport._owned_source_sid = FakePublication.sid
        transport._room = FakeRoom()  # type: ignore[assignment]
        await transport.unpublish_track(FakePublication())
        assert closed == [True], "the SDK-built source was left open"
        # And the transport lets go of it, so a second unpublish is a no-op.
        assert transport._owned_source is None

    asyncio.run(scenario())


def test_an_undecodable_frame_still_reaches_the_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The session turns an undecodable server frame into an UnknownEvent and
    keeps iterating. Dropping it in the transport would make that contract
    true on one transport and not the other."""

    async def scenario() -> None:
        socket = FakeSocket([AUDIO_FORMAT])
        recorder = Recorder()
        transport = await connected(socket, recorder, monkeypatch)
        await settle()
        socket.push("this is not json at all {")
        await settle()
        assert recorder.frames == [b"this is not json at all {"]
        await transport.disconnect()

    asyncio.run(scenario())


def test_an_ordinary_session_end_closes_the_owned_source() -> None:
    """Ending a session never unpublishes first, so the close has to happen
    on the teardown path everything actually takes."""
    from cosmo_ai.session._livekit import LiveKitTransport

    closed: list[bool] = []

    class FakeInner:
        async def aclose(self) -> None:
            closed.append(True)

    class FakeRoom:
        def isconnected(self) -> bool:
            return True

        async def disconnect(self) -> None:
            return None

    async def scenario() -> None:
        transport = LiveKitTransport()
        source = PcmAudioSource(48000, 1)
        source._livekit_source = FakeInner()
        transport._owned_source = source
        transport._room = FakeRoom()  # type: ignore[assignment]
        await transport.disconnect()
        assert closed == [True], "the SDK-built source survived the session"
        assert transport._owned_source is None

    asyncio.run(scenario())


def test_stopping_video_does_not_close_a_live_audio_source() -> None:
    """`unpublish_track` also serves screen share and video streams. A
    transport-global owned source meant stopping video closed the audio the
    session was still speaking through."""
    from cosmo_ai.session._livekit import LiveKitTransport

    closed: list[bool] = []

    class FakeInner:
        async def aclose(self) -> None:
            closed.append(True)

    class Publication:
        def __init__(self, sid: str) -> None:
            self.sid = sid

    class FakeParticipant:
        async def unpublish_track(self, sid: str) -> None:
            return None

    class FakeRoom:
        local_participant = FakeParticipant()

    async def scenario() -> None:
        transport = LiveKitTransport()
        source = PcmAudioSource(48000, 1)
        source._livekit_source = FakeInner()
        transport._owned_source = source
        transport._owned_source_sid = "audio-1"
        transport._room = FakeRoom()  # type: ignore[assignment]
        await transport.unpublish_track(Publication("video-9"))
        assert closed == [], "stopping video closed the audio source"
        assert transport._owned_source is source
        await transport.unpublish_track(Publication("audio-1"))
        assert closed == [True]

    asyncio.run(scenario())


def test_the_sync_close_leaves_the_native_source_closable() -> None:
    """`close()` cannot await, so erasing the WebRTC handle there would leave
    `aclose()` nothing to release and hold the native resource."""
    closed: list[bool] = []

    class FakeInner:
        async def aclose(self) -> None:
            closed.append(True)

    async def scenario() -> None:
        source = PcmAudioSource(48000, 1)
        source._livekit_source = FakeInner()
        source.open_pcm_queue()
        source.close()
        await source.aclose()
        assert closed == [True], "the native source was orphaned by close()"

    asyncio.run(scenario())


def test_capture_follows_a_mid_session_format_change(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A ``ws-audio-format`` mid-call has to move both halves of the session.

    The playback resampler was rebuilt and the microphone was not, so the agent
    followed the new rate while the caller's audio kept arriving at the old one.
    Nothing raised; the server simply received mis-rated PCM.
    """

    async def scenario() -> None:
        socket = FakeSocket([AUDIO_FORMAT])
        recorder = Recorder()
        transport = await connected(socket, recorder, monkeypatch)
        await settle()

        source = PcmAudioSource(48000, 1)
        await transport.publish_audio_source(source)

        # 240 ms at 48 kHz, in 20 ms frames, at the preamble's 16 kHz.
        for _ in range(12):
            await source.capture_frame(Frame(b"\x00\x08" * 960, 48000))
        await settle()
        before = len(b"".join(socket.binary_frames()))

        socket.push(
            json.dumps(
                {
                    "type": "ws-audio-format",
                    "input_sample_rate_hz": 8000,
                    "output_sample_rate_hz": 12000,
                    "num_channels": 1,
                }
            )
        )
        await settle()
        assert transport._output_rate == 12000  # playback moved, as it already did

        socket.sent.clear()
        for _ in range(12):
            await source.capture_frame(Frame(b"\x00\x08" * 960, 48000))
        await settle()
        after = len(b"".join(socket.binary_frames()))

        # The same 240 ms at half the rate is half the bytes.
        assert after == pytest.approx(before // 2, abs=200), (
            f"capture still at the old rate: {after} bytes where {before // 2} was expected"
        )
        await transport.disconnect()

    asyncio.run(scenario())
