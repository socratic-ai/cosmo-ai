"""Adapter-specific logic that lives only in ``LiveKitTransport``: resolving a
caller to ``caller_is_agent`` from the participant kind, wrapping the vendor-free
RPC handler (including mapping ``RpcMethodError`` onto ``rtc.RpcError``), and the
outbound data-channel publish. The higher-level client-tool dispatch is covered
vendor-free in ``test_client_tools`` / ``test_client_tool_jobs``.
"""

from __future__ import annotations

import asyncio
import threading
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any, Callable

import livekit.rtc as rtc
import pytest
from cosmo_ai.session._livekit import LiveKitTransport, _classify_disconnect
from cosmo_ai._internal.transport import (
    RpcInvocation,
    RpcMethodError,
    TransportCallbacks,
    TransportClose,
)
from cosmo_ai._internal.protocol import SessionResponse
from cosmo_ai.errors import NotConnectedError, VideoPublishAlreadyActiveError

_AGENT_KIND = rtc.ParticipantKind.PARTICIPANT_KIND_AGENT
_HUMAN_KIND = rtc.ParticipantKind.PARTICIPANT_KIND_STANDARD


@dataclass
class _FakeParticipant:
    identity: str
    kind: Any


@dataclass
class _FakeLocalParticipant:
    sent: list[tuple[bytes, bool]] = field(default_factory=list)
    rpc_methods: dict[str, Callable[[Any], Any]] = field(default_factory=dict)
    published_tracks: list[tuple[Any, Any]] = field(default_factory=list)
    unpublished_sids: list[str] = field(default_factory=list)
    publish_gate: Any = None  # asyncio.Event | None — holds publish_track open

    async def publish_track(self, track: Any, options: Any = None) -> Any:
        if self.publish_gate is not None:
            await self.publish_gate.wait()
        pub = SimpleNamespace(sid=f"pub-{len(self.published_tracks)}")
        self.published_tracks.append((track, options))
        return pub

    async def unpublish_track(self, sid: str) -> None:
        self.unpublished_sids.append(sid)

    async def publish_data(self, payload: bytes, reliable: bool = True) -> None:
        self.sent.append((payload, reliable))

    def register_rpc_method(self, name: str, handler: Callable[[Any], Any]) -> None:
        self.rpc_methods[name] = handler


class _FakeRoom:
    def __init__(self, *participants: _FakeParticipant) -> None:
        self.remote_participants = {p.identity: p for p in participants}
        self.local_participant = _FakeLocalParticipant()

    def isconnected(self) -> bool:
        return True


@dataclass
class _FakeRpcData:
    caller_identity: str
    payload: str


def _connected(*participants: _FakeParticipant) -> LiveKitTransport:
    transport = LiveKitTransport()
    transport._room = _FakeRoom(*participants)
    # connect() latches the session's loop; these tests skip it. The sync
    # tests below have no loop and publish no video, so they go without.
    try:
        transport._loop = asyncio.get_running_loop()
    except RuntimeError:
        pass
    return transport


def test_caller_is_agent_true_for_agent_participant() -> None:
    transport = _connected(_FakeParticipant("agent-1", _AGENT_KIND))
    assert transport._caller_is_agent("agent-1") is True


def test_caller_is_agent_false_for_human_participant() -> None:
    transport = _connected(_FakeParticipant("human-1", _HUMAN_KIND))
    assert transport._caller_is_agent("human-1") is False


def test_caller_is_agent_false_for_unknown_identity() -> None:
    transport = _connected(_FakeParticipant("agent-1", _AGENT_KIND))
    assert transport._caller_is_agent("ghost") is False


def test_register_rpc_method_delivers_resolved_invocation() -> None:
    async def scenario() -> None:
        transport = _connected(_FakeParticipant("agent-1", _AGENT_KIND))
        seen: dict[str, RpcInvocation] = {}

        async def handler(invocation: RpcInvocation) -> str:
            seen["invocation"] = invocation
            return "the-reply"

        transport.register_rpc_method("tool", handler)
        method = transport._room.local_participant.rpc_methods["tool"]

        reply = await method(_FakeRpcData(caller_identity="agent-1", payload="{}"))
        assert reply == "the-reply"
        invocation = seen["invocation"]
        assert invocation.caller_identity == "agent-1"
        assert invocation.payload == "{}"
        assert invocation.caller_is_agent is True

    asyncio.run(scenario())


def test_register_rpc_method_maps_rpc_method_error_to_livekit() -> None:
    async def scenario() -> None:
        transport = _connected(_FakeParticipant("human-1", _HUMAN_KIND))

        async def handler(invocation: RpcInvocation) -> str:
            # A handler that rejects (e.g. the caller guard) raises the
            # vendor-free error; the adapter must surface it as a real RPC error.
            raise RpcMethodError(code=1500, message="rejected")

        transport.register_rpc_method("tool", handler)
        method = transport._room.local_participant.rpc_methods["tool"]

        with pytest.raises(rtc.RpcError) as excinfo:
            await method(_FakeRpcData(caller_identity="human-1", payload="{}"))
        assert excinfo.value.code == 1500
        assert "rejected" in excinfo.value.message

    asyncio.run(scenario())


def test_send_frame_publishes_reliable_and_is_connected() -> None:
    async def scenario() -> None:
        transport = _connected()
        await transport.send_frame(b'{"type":"ping"}')
        assert transport._room.local_participant.sent == [(b'{"type":"ping"}', True)]
        assert transport.is_connected() is True

    asyncio.run(scenario())


def test_send_frame_raises_when_not_connected() -> None:
    async def scenario() -> None:
        transport = LiveKitTransport()
        assert transport.is_connected() is False
        with pytest.raises(NotConnectedError):
            await transport.send_frame(b"{}")

    asyncio.run(scenario())


@dataclass
class _FakeDataPacket:
    data: bytes
    participant: Any = None


def _callbacks(frames: list[bytes]) -> TransportCallbacks:
    return TransportCallbacks(
        on_frame=frames.append,
        on_closed=lambda close: None,
        on_reconnecting=lambda: None,
        on_reconnected=lambda: None,
    )


def _start_response() -> SessionResponse:
    return SessionResponse(
        livekit_url="wss://test.invalid",
        token="test-token",
        room_name="room-test",
        session_id="sess-test",
    )


def test_data_from_agent_participant_is_forwarded() -> None:
    agent = _FakeParticipant("agent-1", _AGENT_KIND)
    transport = _connected(agent)
    frames: list[bytes] = []
    transport._callbacks = _callbacks(frames)
    transport._on_data_received(_FakeDataPacket(data=b'{"type":"pong"}', participant=agent))
    assert frames == [b'{"type":"pong"}']


def test_data_from_non_agent_participant_is_dropped() -> None:
    # A room peer (SIP leg, another client) must not be able to inject
    # protocol frames into the event stream.
    human = _FakeParticipant("human-1", _HUMAN_KIND)
    transport = _connected(_FakeParticipant("agent-1", _AGENT_KIND), human)
    frames: list[bytes] = []
    transport._callbacks = _callbacks(frames)
    transport._on_data_received(_FakeDataPacket(data=b'{"type":"pong"}', participant=human))
    assert frames == []


def test_data_without_participant_is_forwarded() -> None:
    # Server-API data carries no participant; only room peers are filtered.
    transport = _connected(_FakeParticipant("agent-1", _AGENT_KIND))
    frames: list[bytes] = []
    transport._callbacks = _callbacks(frames)
    transport._on_data_received(_FakeDataPacket(data=b'{"type":"pong"}'))
    assert frames == [b'{"type":"pong"}']


def _stub_screen_rtc(monkeypatch: pytest.MonkeyPatch) -> None:
    class _FakeVideoSource:
        def __init__(self, width: int, height: int) -> None:
            self.frames: list[Any] = []

        def capture_frame(self, frame: Any) -> None:
            self.frames.append(frame)

    class _FakeVideoTrack:
        def __init__(self, name: str, source: Any) -> None:
            self.name = name
            self.source = source

    stub = SimpleNamespace(
        VideoSource=_FakeVideoSource,
        LocalVideoTrack=SimpleNamespace(
            create_video_track=lambda name, source: _FakeVideoTrack(name, source)
        ),
        TrackPublishOptions=lambda **kw: SimpleNamespace(**kw),
        TrackSource=SimpleNamespace(
            SOURCE_SCREENSHARE="screenshare", SOURCE_CAMERA="camera"
        ),
    )
    import cosmo_ai.session._livekit as lkmod

    monkeypatch.setattr(lkmod, "_import_livekit_rtc", lambda feature: stub)


def test_screen_share_publish_is_deferred_to_the_first_frame(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def scenario() -> None:
        _stub_screen_rtc(monkeypatch)
        transport = _connected()
        await transport.start_screen_share(width=640, height=480)
        assert transport._room.local_participant.published_tracks == []

        transport.push_screen_share_frame("frame-1")
        state = transport._video_publish
        assert state is not None
        assert state.source.frames == ["frame-1"]
        for _ in range(3):
            await asyncio.sleep(0)
        assert len(transport._room.local_participant.published_tracks) == 1
        assert state.publication is not None

    asyncio.run(scenario())


def test_stop_screen_share_unpublishes_and_later_frames_are_noops(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def scenario() -> None:
        _stub_screen_rtc(monkeypatch)
        transport = _connected()
        await transport.start_screen_share(width=640, height=480)
        transport.push_screen_share_frame("f")
        for _ in range(3):
            await asyncio.sleep(0)

        await transport.stop_screen_share()
        assert transport._room.local_participant.unpublished_sids == ["pub-0"]
        assert transport._video_publish is None
        transport.push_screen_share_frame("late")  # no active share — no-op
        assert transport._room.local_participant.published_tracks[0][0].source.frames == ["f"]

    asyncio.run(scenario())


def test_stop_racing_an_inflight_publish_unpublishes_the_orphan(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # stop_screen_share can clear the state while publish_track is awaiting;
    # the completed publish must then unpublish itself rather than leak.
    async def scenario() -> None:
        _stub_screen_rtc(monkeypatch)
        transport = _connected()
        gate = asyncio.Event()
        transport._room.local_participant.publish_gate = gate
        await transport.start_screen_share(width=640, height=480)
        transport.push_screen_share_frame("f")
        transport._video_publish = None  # the race: stopped mid-publish
        gate.set()
        for _ in range(3):
            await asyncio.sleep(0)
        assert transport._room.local_participant.unpublished_sids == ["pub-0"]

    asyncio.run(scenario())


def test_failed_connect_disconnects_the_room(monkeypatch: pytest.MonkeyPatch) -> None:
    async def scenario() -> None:
        rooms: list[Any] = []

        class _FailingRoom:
            def __init__(self) -> None:
                self.disconnect_called = False
                rooms.append(self)

            def on(self, event: str, cb: Any) -> None:
                pass

            async def connect(self, url: str, token: str) -> None:
                raise RuntimeError("join refused")

            async def disconnect(self) -> None:
                self.disconnect_called = True

        monkeypatch.setattr(rtc, "Room", _FailingRoom)
        transport = LiveKitTransport()
        with pytest.raises(RuntimeError, match="join refused"):
            await transport.connect(_start_response(), _callbacks([]))
        assert rooms[0].disconnect_called is True
        assert transport._room is None

    asyncio.run(scenario())


def test_cancelled_connect_disconnects_the_room(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def scenario() -> None:
        rooms: list[Any] = []
        entered = asyncio.Event()

        class _HangingRoom:
            def __init__(self) -> None:
                self.disconnect_called = False
                rooms.append(self)

            def on(self, event: str, cb: Any) -> None:
                pass

            async def connect(self, url: str, token: str) -> None:
                entered.set()
                await asyncio.Event().wait()

            async def disconnect(self) -> None:
                self.disconnect_called = True

        monkeypatch.setattr(rtc, "Room", _HangingRoom)
        transport = LiveKitTransport()
        task = asyncio.ensure_future(
            transport.connect(_start_response(), _callbacks([]))
        )
        await asyncio.wait_for(entered.wait(), timeout=1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert rooms[0].disconnect_called is True
        assert transport._room is None

    asyncio.run(scenario())


def test_pre_connect_rpc_registration_is_bound_at_connect(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A method registered before ``connect`` is parked, then bound onto the
    room in the same tick the connect resolves — so an invocation the FFI
    queue buffered during the join is handled once it drains, not rejected
    as unknown (the join→register race)."""

    async def scenario() -> None:
        class _ConnectableRoom(_FakeRoom):
            def __init__(self) -> None:
                super().__init__(_FakeParticipant("agent-1", _AGENT_KIND))

            def on(self, event: str, cb: Any) -> None:
                pass

            async def connect(self, url: str, token: str) -> None:
                pass

        room = _ConnectableRoom()
        monkeypatch.setattr(rtc, "Room", lambda: room)
        transport = LiveKitTransport()

        async def handler(invocation: RpcInvocation) -> str:
            assert invocation.caller_is_agent is True
            return "early-reply"

        transport.register_rpc_method("early_tool", handler)
        # Parked, not bound: no room exists yet.
        assert room.local_participant.rpc_methods == {}

        await transport.connect(_start_response(), _callbacks([]))
        method = room.local_participant.rpc_methods["early_tool"]
        reply = await method(_FakeRpcData(caller_identity="agent-1", payload="{}"))
        assert reply == "early-reply"

    asyncio.run(scenario())


@pytest.mark.parametrize(
    ("value", "kind", "detail"),
    [
        (5, "server_ended", "ROOM_DELETED"),
        (4, "server_ended", "PARTICIPANT_REMOVED"),
        (10, "server_ended", "ROOM_CLOSED"),
        (3, "transport_error", "SERVER_SHUTDOWN"),
        (0, "transport_error", "UNKNOWN_REASON"),
        (999, "transport_error", "999"),
        (None, "transport_error", None),
    ],
)
def test_classify_disconnect(value: object, kind: str, detail: str | None) -> None:
    close = _classify_disconnect(value)
    assert close == TransportClose(kind=kind, detail=detail)  # type: ignore[arg-type]


# ── Agent-audio reader ─────────────────────────────────────────────


@dataclass
class _FakeRemoteAudioTrack:
    kind: Any
    frames: list[Any] = field(default_factory=list)


class _FakeStreamEvent:
    def __init__(self, frame: Any) -> None:
        self.frame = frame


class _FakeAudioStream:
    """Yields the track's queued frames, then blocks until aclose()."""

    def __init__(self, track: Any, sample_rate: int, num_channels: int) -> None:
        self.sample_rate = sample_rate
        self.num_channels = num_channels
        self._frames = list(track.frames)
        self._closed = asyncio.Event()

    def __aiter__(self) -> "_FakeAudioStream":
        return self

    async def __anext__(self) -> _FakeStreamEvent:
        if self._frames:
            return _FakeStreamEvent(self._frames.pop(0))
        await self._closed.wait()
        raise StopAsyncIteration

    async def aclose(self) -> None:
        self._closed.set()


class _ExplodingAudioStream(_FakeAudioStream):
    async def __anext__(self) -> _FakeStreamEvent:
        raise RuntimeError("decode failed")


class _RecordingSink:
    def __init__(self) -> None:
        self.frames: list[Any] = []
        self.closed = False

    def deliver(self, frame: Any) -> None:
        self.frames.append(frame)

    def close(self) -> None:
        self.closed = True


def _audio_rtc_stub(stream_cls: type[_FakeAudioStream]) -> SimpleNamespace:
    return SimpleNamespace(
        ParticipantKind=rtc.ParticipantKind,
        TrackKind=rtc.TrackKind,
        AudioStream=stream_cls,
    )


def _pcm_frame() -> SimpleNamespace:
    return SimpleNamespace(
        data=memoryview(b"\x01\x02" * 480),
        sample_rate=48000,
        num_channels=1,
        samples_per_channel=480,
    )


def _wire_agent_audio_rtc(
    monkeypatch: pytest.MonkeyPatch,
    stream_cls: type[_FakeAudioStream] = _FakeAudioStream,
) -> _FakeRemoteAudioTrack:
    import cosmo_ai.session._livekit as lkmod

    monkeypatch.setattr(
        lkmod, "_import_livekit_rtc", lambda feature: _audio_rtc_stub(stream_cls)
    )
    track = _FakeRemoteAudioTrack(kind=rtc.TrackKind.KIND_AUDIO)
    track.frames.append(_pcm_frame())
    return track


def test_sink_attached_then_track_subscribed_delivers_vendor_free_frames(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def scenario() -> None:
        transport = LiveKitTransport()
        track = _wire_agent_audio_rtc(monkeypatch)
        sink = _RecordingSink()
        transport.set_agent_audio_sink(sink)
        assert transport._agent_audio_task is None  # no track yet
        transport._on_track_subscribed(
            track, None, _FakeParticipant(identity="agent-1", kind=_AGENT_KIND)
        )
        for _ in range(10):
            await asyncio.sleep(0)
        assert len(sink.frames) == 1
        frame = sink.frames[0]
        assert isinstance(frame.data, bytes)
        assert frame.data == b"\x01\x02" * 480
        assert frame.sample_rate == 48000
        assert frame.samples_per_channel == 480
        transport.set_agent_audio_sink(None)
        assert transport._agent_audio_task is None

    asyncio.run(scenario())


def test_non_agent_and_non_audio_tracks_are_ignored(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def scenario() -> None:
        transport = LiveKitTransport()
        _wire_agent_audio_rtc(monkeypatch)
        sink = _RecordingSink()
        transport.set_agent_audio_sink(sink)
        human_track = _FakeRemoteAudioTrack(kind=rtc.TrackKind.KIND_AUDIO)
        transport._on_track_subscribed(
            human_track, None, _FakeParticipant(identity="callee", kind=_HUMAN_KIND)
        )
        video_track = _FakeRemoteAudioTrack(kind=rtc.TrackKind.KIND_VIDEO)
        transport._on_track_subscribed(
            video_track, None, _FakeParticipant(identity="agent-1", kind=_AGENT_KIND)
        )
        for _ in range(5):
            await asyncio.sleep(0)
        assert sink.frames == []
        assert transport._agent_audio_task is None

    asyncio.run(scenario())


def test_track_present_before_sink_attach_is_found(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def scenario() -> None:
        transport = LiveKitTransport()
        track = _wire_agent_audio_rtc(monkeypatch)
        publication = SimpleNamespace(track=track, kind=rtc.TrackKind.KIND_AUDIO)
        agent = SimpleNamespace(
            identity="agent-1",
            kind=_AGENT_KIND,
            track_publications={"pub": publication},
        )
        transport._room = SimpleNamespace(remote_participants={"agent-1": agent})
        sink = _RecordingSink()
        transport.set_agent_audio_sink(sink)
        for _ in range(10):
            await asyncio.sleep(0)
        assert len(sink.frames) == 1

    asyncio.run(scenario())


def test_reader_crash_keeps_sink_open_and_recovers_on_resubscribe(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def scenario() -> None:
        import cosmo_ai.session._livekit as lkmod

        transport = LiveKitTransport()
        track = _wire_agent_audio_rtc(monkeypatch, _ExplodingAudioStream)
        sink = _RecordingSink()
        transport.set_agent_audio_sink(sink)
        agent = _FakeParticipant(identity="agent-1", kind=_AGENT_KIND)
        transport._on_track_subscribed(track, None, agent)
        for _ in range(10):
            await asyncio.sleep(0)
        # a decode failure ends the reader but never latches the sink shut
        assert sink.closed is False
        assert sink.frames == []
        assert transport._agent_audio_task is None
        # the next track subscription re-arms the pipeline
        monkeypatch.setattr(
            lkmod, "_import_livekit_rtc", lambda feature: _audio_rtc_stub(_FakeAudioStream)
        )
        fresh = _FakeRemoteAudioTrack(kind=rtc.TrackKind.KIND_AUDIO)
        fresh.frames.append(_pcm_frame())
        transport._on_track_subscribed(fresh, None, agent)
        for _ in range(10):
            await asyncio.sleep(0)
        assert len(sink.frames) == 1

    asyncio.run(scenario())


def test_resubscribe_restarts_reader_on_fresh_track(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def scenario() -> None:
        transport = LiveKitTransport()
        track = _wire_agent_audio_rtc(monkeypatch)
        sink = _RecordingSink()
        transport.set_agent_audio_sink(sink)
        agent = _FakeParticipant(identity="agent-1", kind=_AGENT_KIND)
        transport._on_track_subscribed(track, None, agent)
        for _ in range(10):
            await asyncio.sleep(0)
        first_task = transport._agent_audio_task
        fresh = _FakeRemoteAudioTrack(kind=rtc.TrackKind.KIND_AUDIO)
        fresh.frames.append(_pcm_frame())
        transport._on_track_subscribed(fresh, None, agent)
        for _ in range(10):
            await asyncio.sleep(0)
        assert transport._agent_audio_task is not first_task
        assert len(sink.frames) == 2

    asyncio.run(scenario())


def _published_source(transport: Any) -> str:
    ((_, options),) = transport._room.local_participant.published_tracks
    return str(options.source)


def test_a_video_stream_publishes_under_the_camera_source(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The source is how the backend tells a camera feed from a shared screen,
    # and what keeps the screen tools anchored to actual screen shares.
    async def scenario() -> None:
        _stub_screen_rtc(monkeypatch)
        transport = _connected()
        stream_id = await transport.add_video_stream(width=640, height=480)
        assert transport._room.local_participant.published_tracks == []

        transport.push_video_frame(stream_id, "frame-1")
        for _ in range(3):
            await asyncio.sleep(0)
        assert _published_source(transport) == "camera"

    asyncio.run(scenario())


def test_a_screen_share_still_publishes_under_the_screen_source(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def scenario() -> None:
        _stub_screen_rtc(monkeypatch)
        transport = _connected()
        await transport.start_screen_share(width=640, height=480)
        transport.push_screen_share_frame("f")
        for _ in range(3):
            await asyncio.sleep(0)
        assert _published_source(transport) == "screenshare"

    asyncio.run(scenario())


def test_one_video_publish_at_a_time(monkeypatch: pytest.MonkeyPatch) -> None:
    # Both directions: neither kind may quietly displace the other's track.
    async def scenario() -> None:
        _stub_screen_rtc(monkeypatch)
        transport = _connected()
        await transport.add_video_stream(width=640, height=480)
        with pytest.raises(VideoPublishAlreadyActiveError):
            await transport.add_video_stream(width=640, height=480)
        with pytest.raises(VideoPublishAlreadyActiveError):
            await transport.start_screen_share(width=640, height=480)

        transport._video_publish = None
        await transport.start_screen_share(width=640, height=480)
        with pytest.raises(VideoPublishAlreadyActiveError):
            await transport.add_video_stream(width=640, height=480)

    asyncio.run(scenario())


def test_restarting_a_screen_share_replaces_it(monkeypatch: pytest.MonkeyPatch) -> None:
    # Documented idempotence, and the reason the refusal above is keyed to the
    # publish kind rather than to "something is publishing".
    async def scenario() -> None:
        _stub_screen_rtc(monkeypatch)
        transport = _connected()
        await transport.start_screen_share(width=640, height=480)
        first = transport._video_publish
        await transport.start_screen_share(width=320, height=240)
        assert transport._video_publish is not first

    asyncio.run(scenario())


def test_removing_a_video_stream_unpublishes_and_later_pushes_are_inert(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def scenario() -> None:
        _stub_screen_rtc(monkeypatch)
        transport = _connected()
        stream_id = await transport.add_video_stream(width=640, height=480)
        transport.push_video_frame(stream_id, "f")
        for _ in range(3):
            await asyncio.sleep(0)

        await transport.remove_video_stream(stream_id)
        assert transport._room.local_participant.unpublished_sids == ["pub-0"]
        assert transport._video_publish is None

        transport.push_video_frame(stream_id, "late")
        await transport.remove_video_stream(stream_id)  # idempotent
        published = transport._room.local_participant.published_tracks[0][0]
        assert published.source.frames == ["f"]

    asyncio.run(scenario())


def test_a_stale_handle_never_touches_a_later_stream(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Identity-keyed: the app may still hold the old handle, and its frames
    # must not land in — or tear down — whatever is publishing now.
    async def scenario() -> None:
        _stub_screen_rtc(monkeypatch)
        transport = _connected()
        stale = await transport.add_video_stream(width=640, height=480)
        await transport.remove_video_stream(stale)
        current = await transport.add_video_stream(width=640, height=480)
        assert current != stale

        transport.push_video_frame(stale, "wrong")
        await transport.remove_video_stream(stale)
        assert transport._video_publish is not None
        assert transport._video_publish.source.frames == []

    asyncio.run(scenario())


def test_a_frame_pushed_from_a_capture_thread_still_publishes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``VideoStreamHandle.push`` is sync and documented as safe from a
    capture thread, which is where a camera loop naturally runs.

    Scheduling the deferred publish needs a loop in the *calling* thread, so
    an app that pushed from its own thread got RuntimeError, no publish task,
    and no recovery — while ``capture_frame`` kept succeeding, so the source
    filled with frames that were never on the wire.
    """

    async def scenario() -> None:
        _stub_screen_rtc(monkeypatch)
        transport = _connected()
        stream_id = await transport.add_video_stream(width=640, height=480)

        failure: list[BaseException] = []

        def capture_loop() -> None:
            try:
                transport.push_video_frame(stream_id, "frame-from-thread")
            except BaseException as exc:  # noqa: BLE001 - reported, not swallowed
                failure.append(exc)

        thread = threading.Thread(target=capture_loop)
        thread.start()
        while thread.is_alive():
            await asyncio.sleep(0)
        thread.join()

        assert failure == []
        state = transport._video_publish
        assert state is not None
        assert state.source.frames == ["frame-from-thread"]
        for _ in range(5):
            await asyncio.sleep(0)
        assert len(transport._room.local_participant.published_tracks) == 1
        assert state.publication is not None

    asyncio.run(scenario())


def test_a_stream_removed_before_its_threaded_publish_lands_never_publishes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The hop from a capture thread is a queued callback, so a removal can
    # overtake it; the track must not go up for a stream that is already gone.
    async def scenario() -> None:
        _stub_screen_rtc(monkeypatch)
        transport = _connected()
        stream_id = await transport.add_video_stream(width=640, height=480)
        state = transport._video_publish
        assert state is not None

        thread = threading.Thread(
            target=lambda: transport.push_video_frame(stream_id, "f")
        )
        thread.start()
        thread.join()

        await transport.remove_video_stream(stream_id)
        for _ in range(5):
            await asyncio.sleep(0)
        assert transport._room.local_participant.published_tracks == []

    asyncio.run(scenario())


def test_a_session_that_ends_before_its_threaded_publish_lands_never_publishes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # disconnect() is remove_video_stream's sibling: it tears down the same
    # state, so it owes the same guard. Without it the queued hop spawned a
    # publish against a room that was already None, and an ordinary shutdown
    # logged a stack trace.
    async def scenario() -> None:
        _stub_screen_rtc(monkeypatch)
        transport = _connected()
        room = transport._room
        stream_id = await transport.add_video_stream(width=640, height=480)
        state = transport._video_publish
        assert state is not None

        thread = threading.Thread(
            target=lambda: transport.push_video_frame(stream_id, "f")
        )
        thread.start()
        thread.join()

        await transport.disconnect()
        for _ in range(5):
            await asyncio.sleep(0)
        assert state.publish_task is None
        assert room.local_participant.published_tracks == []

    asyncio.run(scenario())
