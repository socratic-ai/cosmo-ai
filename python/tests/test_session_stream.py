"""Event-stream semantics: unknown-event tolerance, envelope reassembly,
session-ended finality, and the wire shapes of the send methods."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
from types import SimpleNamespace
from typing import Any
from unittest import mock

import pytest
import structlog.testing
from cosmo_ai import (
    AudioUnavailableError,
    DisconnectReason,
    ModelTextEvent,
    ReadyEvent,
    RealtimeSession,
    SessionEndedEvent,
    TranscriptDeltaEvent,
    SessionStateWriteEvent,
    TranscriptRole,
    UsageEvent,
    SessionStartError,
    RealtimeSessionState,
    SessionStateKind,
    UnknownEvent,
    VersionMismatchError,
)

import httpx

from cosmo_ai.session._livekit import (
    _IgnoredLivekitStreamFilter,
    _quiet_expected_livekit_streams,
)

from cosmo_ai.tools import ClientTool

from .fakes import FakeSessionHarness, FakeTransport, start_fake_session


def _stream_ignore_record(verb: str, topic: str) -> logging.LogRecord:
    return logging.LogRecord(
        name="root",
        level=logging.INFO,
        pathname=__file__,
        lineno=0,
        msg=f"ignoring {verb} stream with topic '%s', no callback attached",
        args=(topic,),
        exc_info=None,
    )

READY_FRAME: dict[str, Any] = {
    "type": "ready",
    "session_id": "sess-test",
}


async def _inject(session: RealtimeSession, *frames: dict[str, Any] | str) -> None:
    for frame in frames:
        raw = frame if isinstance(frame, str) else json.dumps(frame)
        await session._handle_payload(raw.encode("utf-8"))


async def _collect(session: RealtimeSession, count: int) -> list[Any]:
    return [await asyncio.wait_for(session.__anext__(), timeout=1) for _ in range(count)]


def test_unknown_event_type_is_tolerated_and_stream_continues() -> None:
    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None
        await _inject(
            session,
            READY_FRAME,
            {"type": "telemetry-snapshot", "metrics": {"rtt_ms": 42}},
            {"type": "transcript", "role": "ASSISTANT", "text": "Still here.", "is_final": True},
        )
        ready, unknown, transcript = await _collect(session, 3)
        assert isinstance(ready, ReadyEvent)
        assert ready.session_id == "sess-test"
        assert isinstance(unknown, UnknownEvent)
        assert unknown.raw_type == "telemetry-snapshot"
        assert unknown.payload == {"type": "telemetry-snapshot", "metrics": {"rtt_ms": 42}}
        assert isinstance(transcript, TranscriptDeltaEvent)
        assert transcript.text == "Still here."
        assert session.state.kind is SessionStateKind.CONNECTED

    asyncio.run(scenario())


def test_ready_parses_duration_cap_and_tolerates_retired_fields() -> None:
    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None
        await _inject(
            session,
            {
                **READY_FRAME,
                "max_session_seconds": 1800,
                # Retired block a backend that predates its removal may still
                # send — must be tolerated, never surfaced.
                "cosmo": {
                    "authorized_client_tools": [],
                    "client_directives": {"audio_gating": "wake_word_window"},
                },
            },
            READY_FRAME,
        )
        capped, plain = await _collect(session, 2)
        assert isinstance(capped, ReadyEvent)
        assert capped.max_session_seconds == 1800
        assert not hasattr(capped, "cosmo")
        assert isinstance(plain, ReadyEvent)
        assert plain.max_session_seconds is None

    asyncio.run(scenario())


def test_undecodable_frame_surfaces_unknown_with_null_raw_type() -> None:
    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None
        await _inject(session, '{"type": "transcript", "role":')
        (unknown,) = await _collect(session, 1)
        assert isinstance(unknown, UnknownEvent)
        assert unknown.raw_type is None
        assert unknown.raw_text == '{"type": "transcript", "role":'
        assert session.state.kind is SessionStateKind.CONNECTED

    asyncio.run(scenario())


def test_known_type_failing_validation_degrades_to_unknown_event() -> None:
    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None
        await _inject(session, {"type": "transcript", "role": "NARRATOR", "text": "x"})
        (unknown,) = await _collect(session, 1)
        assert isinstance(unknown, UnknownEvent)
        assert unknown.raw_type == "transcript"

    asyncio.run(scenario())


@pytest.mark.parametrize("wire_role", ["ASSISTANT", "assistant", "Assistant"])
def test_transcript_role_decodes_any_casing_to_lowercase(wire_role: str) -> None:
    """The wire spells roles uppercase; user code compares lowercase."""

    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None
        await _inject(
            session,
            {"type": "transcript", "role": wire_role, "text": "hi", "is_final": True},
        )
        (event,) = await _collect(session, 1)
        assert isinstance(event, TranscriptDeltaEvent)
        assert event.role is TranscriptRole.ASSISTANT
        assert event.role.value == "assistant"
        assert event.role == "assistant"

    asyncio.run(scenario())


def test_usage_event_decodes_to_typed_model() -> None:
    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None
        await _inject(
            session,
            {
                "type": "cosmo.usage",
                "input_text_tokens": 12,
                "output_audio_tokens": 46,
                "total_tokens": 58,
            },
        )
        (event,) = await _collect(session, 1)
        assert isinstance(event, UsageEvent)
        assert event.input_text_tokens == 12
        assert event.output_audio_tokens == 46
        assert event.total_tokens == 58
        # Absent counters are zero, not unset.
        assert event.input_cached_tokens == 0

    asyncio.run(scenario())


def test_session_state_event_decodes_to_typed_model() -> None:
    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None
        await _inject(
            session,
            {
                "type": "cosmo.session-state",
                "state": {"stage": "qualifying", "name": "Ada"},
                "updated_keys": ["name"],
                "warnings": ["name is not in the schema"],
                "stage": "qualifying",
            },
        )
        (event,) = await _collect(session, 1)
        assert isinstance(event, SessionStateWriteEvent)
        assert event.stage == "qualifying"
        assert event.state == {"stage": "qualifying", "name": "Ada"}
        assert event.updated_keys == ["name"]
        assert event.warnings == ["name is not in the schema"]

    asyncio.run(scenario())


def test_session_state_event_defaults_are_empty_not_missing() -> None:
    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None
        await _inject(session, {"type": "cosmo.session-state"})
        (event,) = await _collect(session, 1)
        assert isinstance(event, SessionStateWriteEvent)
        assert event.state == {}
        assert event.updated_keys == []
        assert event.warnings == []
        assert event.stage is None

    asyncio.run(scenario())


def test_envelope_chunks_reassemble_into_one_event() -> None:
    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None
        inner = json.dumps(
            {"type": "model-text", "text": "long payload " * 40, "is_final": True}
        ).encode("utf-8")
        third = len(inner) // 3
        parts = [inner[:third], inner[third : 2 * third], inner[2 * third :]]
        chunks = [
            {
                "type": "server-envelope-chunk",
                "envelope_id": "env-1",
                "seq": seq,
                "total": 3,
                "data": base64.b64encode(part).decode("ascii"),
            }
            for seq, part in enumerate(parts)
        ]
        await _inject(session, *chunks)
        (event,) = await _collect(session, 1)
        assert isinstance(event, ModelTextEvent)
        assert event.text == "long payload " * 40
        assert event.is_final is True
        assert session._queue.empty()

    asyncio.run(scenario())


def _envelope_chunk(
    *, envelope_id: str, seq: int, total: int, part: bytes
) -> dict[str, Any]:
    return {
        "type": "server-envelope-chunk",
        "envelope_id": envelope_id,
        "seq": seq,
        "total": total,
        "data": base64.b64encode(part).decode("ascii"),
    }


def test_envelope_chunk_with_out_of_range_seq_is_dropped() -> None:
    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None
        # seq >= total is malformed: ignored, leaves no buffered state.
        await _inject(
            session, _envelope_chunk(envelope_id="bad", seq=5, total=3, part=b"x")
        )
        assert session._queue.empty()
        assert session._envelope_buffers == {}
        assert session._envelope_totals == {}

    asyncio.run(scenario())


def test_envelope_duplicate_seq_does_not_stall_reassembly() -> None:
    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None
        inner = json.dumps(
            {"type": "model-text", "text": "hello there", "is_final": True}
        ).encode("utf-8")
        half = len(inner) // 2
        first, second = inner[:half], inner[half:]
        await _inject(
            session,
            _envelope_chunk(envelope_id="dup", seq=0, total=2, part=first),
            _envelope_chunk(envelope_id="dup", seq=0, total=2, part=first),  # duplicate
            _envelope_chunk(envelope_id="dup", seq=1, total=2, part=second),
        )
        (event,) = await _collect(session, 1)
        assert isinstance(event, ModelTextEvent)
        assert event.text == "hello there"
        assert session._envelope_buffers == {}

    asyncio.run(scenario())


def test_envelope_total_mismatch_discards_the_envelope() -> None:
    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None
        # A second chunk that disagrees on ``total`` poisons the envelope; the
        # SDK drops it rather than reassembling a corrupt payload.
        await _inject(
            session,
            _envelope_chunk(envelope_id="mm", seq=0, total=2, part=b"x"),
            _envelope_chunk(envelope_id="mm", seq=1, total=3, part=b"y"),
        )
        assert session._queue.empty()
        assert session._envelope_buffers == {}
        assert session._envelope_totals == {}

    asyncio.run(scenario())


def test_envelope_with_invalid_base64_surfaces_unknown_and_continues() -> None:
    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None
        # A complete envelope whose data is not valid base64 must not kill the
        # handler: it surfaces UnknownEvent and the stream keeps flowing.
        await _inject(
            session,
            {
                "type": "server-envelope-chunk",
                "envelope_id": "bad-b64",
                "seq": 0,
                "total": 1,
                "data": "not-base64",
            },
            {"type": "transcript", "role": "ASSISTANT", "text": "still here", "is_final": True},
        )
        unknown, transcript = await _collect(session, 2)
        assert isinstance(unknown, UnknownEvent)
        assert unknown.raw_type == "server-envelope-chunk"
        assert isinstance(transcript, TranscriptDeltaEvent)
        assert transcript.text == "still here"
        assert session._envelope_buffers == {}
        assert session._envelope_totals == {}
        assert session.state.kind is SessionStateKind.CONNECTED

    asyncio.run(scenario())


def test_envelope_claiming_too_many_chunks_is_dropped() -> None:
    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None
        # A chunk count past the ceiling is dropped before buffering anything.
        await _inject(
            session,
            _envelope_chunk(envelope_id="huge", seq=0, total=100_000, part=b"x"),
        )
        assert session._envelope_buffers == {}
        assert session._envelope_totals == {}
        assert session._envelope_chars == {}
        assert session.state.kind is SessionStateKind.CONNECTED

    asyncio.run(scenario())


def test_envelope_accumulating_too_much_data_is_dropped() -> None:
    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None
        # Two chunks whose base64 data crosses the accumulated-size ceiling:
        # the whole envelope is discarded, freeing its buffer.
        big = b"x" * 3_500_000  # base64-encodes to ~4.7M chars, past the 4M cap
        await _inject(
            session,
            _envelope_chunk(envelope_id="fat", seq=0, total=3, part=big),
        )
        assert session._envelope_buffers == {}
        assert session._envelope_totals == {}
        assert session._envelope_chars == {}
        assert session.state.kind is SessionStateKind.CONNECTED

    asyncio.run(scenario())


def test_event_queue_drops_excess_events_without_raising() -> None:
    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None
        session._queue = asyncio.Queue(maxsize=2)
        # A slow consumer can't keep up: events past the bound are dropped, not
        # raised, so the inbound data-channel handler never blows up.
        await _inject(session, READY_FRAME, READY_FRAME, READY_FRAME)
        assert session._queue.qsize() == 2

    asyncio.run(scenario())


def test_terminal_items_survive_a_full_queue() -> None:
    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None
        session._queue = asyncio.Queue(maxsize=2)
        await _inject(session, READY_FRAME, READY_FRAME)  # fill to capacity
        assert session._queue.full()
        await session.end()
        # The ended event must still be delivered and the stream must finish
        # (the sentinel evicts buffered events rather than being dropped).
        seen = [event async for event in session]
        assert any(isinstance(event, SessionEndedEvent) for event in seen)

    asyncio.run(scenario())


def test_set_microphone_enabled_unopenable_device_fails_fast(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A host with no usable input device — headless CI, a denied permission.
    # The device is opened before anything is published, so the failure must
    # leave no track behind for the agent to bind its input to.
    import cosmo_ai.audio._mic as micmod

    def _no_device() -> None:
        raise RuntimeError("no audio device")

    monkeypatch.setattr(micmod, "rtc", SimpleNamespace(PlatformAudio=_no_device))

    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None
        with pytest.raises(AudioUnavailableError):
            await session.set_microphone_enabled(True)
        assert session._mic is None
        assert session._mic_pub is None

    asyncio.run(scenario())


def test_session_start_transport_failure_raises_typed_error() -> None:
    async def scenario() -> None:
        def respond(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("connection refused")

        with pytest.raises(SessionStartError) as exc:
            await start_fake_session(respond=respond)
        assert exc.value.code == "transport_error"

    asyncio.run(scenario())


def test_reconnecting_transitions_state_and_recovers() -> None:
    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None
        harness.transport.simulate_reconnecting()
        mid_kind = session.state.kind
        harness.transport.simulate_reconnected()
        assert mid_kind is SessionStateKind.RECONNECTING
        assert session.state.kind is SessionStateKind.CONNECTED

    asyncio.run(scenario())


def test_envelope_inflight_cap_evicts_the_oldest() -> None:
    import cosmo_ai.session._engine as engine

    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None
        cap = engine._MAX_INFLIGHT_ENVELOPES
        for i in range(cap + 1):
            await _inject(
                session,
                _envelope_chunk(envelope_id=f"env-{i}", seq=0, total=2, part=b"x"),
            )
        assert len(session._envelope_buffers) == cap
        assert "env-0" not in session._envelope_buffers
        assert f"env-{cap}" in session._envelope_buffers

    asyncio.run(scenario())


def test_session_start_with_malformed_2xx_body_raises_typed_error() -> None:
    async def scenario() -> None:
        def respond(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"unexpected": "shape"})

        with pytest.raises(SessionStartError) as exc:
            await start_fake_session(respond=respond)
        assert exc.value.code == "invalid_response"

    asyncio.run(scenario())


class _RegistrationFailingTransport(FakeTransport):
    """Connects fine, then fails the post-connect RPC registration — the
    duplicate-method-name shape of handshake failure."""

    def register_rpc_method(self, name: str, handler: Any) -> None:
        raise RuntimeError(f"RPC method already registered: {name}")


class _HangingConnectTransport(FakeTransport):
    """Signals entry into ``connect`` then never returns, so a test can cancel
    ``start()`` mid-handshake."""

    def __init__(self, sent: list[dict[str, Any]]) -> None:
        super().__init__(sent)
        self.connect_entered = asyncio.Event()

    async def connect(self, response: Any, callbacks: Any) -> None:
        await super().connect(response, callbacks)
        self.connect_entered.set()
        await asyncio.Event().wait()


def _probe_tool() -> ClientTool:
    async def handler(args: dict[str, Any]) -> dict[str, Any]:
        return {}

    return ClientTool(
        name="probe", description="d", parameters={"type": "object"}, handler=handler
    )


def test_post_connect_failure_tears_the_room_down() -> None:
    # A handshake that fails AFTER the room connected (e.g. RPC registration)
    # must disconnect the transport, not leak a live room.
    async def scenario() -> None:
        states: list[RealtimeSessionState] = []
        harness = FakeSessionHarness(transport_cls=_RegistrationFailingTransport)
        with pytest.raises(SessionStartError) as exc:
            await start_fake_session(
                harness=harness,
                on_state_change=states.append,
                tools=[_probe_tool()],
            )
        assert exc.value.code == "room_join_failed"
        assert harness.transport.disconnected is True
        assert states[-1].kind is SessionStateKind.DISCONNECTED
        assert states[-1].disconnect_reason is DisconnectReason.TRANSPORT_ERROR

    asyncio.run(scenario())


def test_start_cancelled_mid_connect_tears_the_room_down() -> None:
    # Cancelling start() while the transport is connecting is a BaseException
    # path — the room must still come down and the state must land DISCONNECTED.
    async def scenario() -> None:
        states: list[RealtimeSessionState] = []
        harness = FakeSessionHarness(transport_cls=_HangingConnectTransport)
        task = asyncio.ensure_future(
            start_fake_session(harness=harness, on_state_change=states.append)
        )
        transport = harness.transport
        assert isinstance(transport, _HangingConnectTransport)
        await asyncio.wait_for(transport.connect_entered.wait(), timeout=1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert transport.disconnected is True
        assert states[-1].kind is SessionStateKind.DISCONNECTED
        assert states[-1].disconnect_reason is DisconnectReason.CLIENT_CLOSED
        assert states[-1].detail == "start cancelled"

    asyncio.run(scenario())


def test_server_sent_session_ended_latches_reason_for_the_terminal() -> None:
    # The server publishes ``session-ended`` best-effort before a deliberate
    # teardown. The frame never surfaces mid-stream; its reason is latched and
    # carried by the terminal sentinel once the transport then drops.
    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None
        await _inject(
            session,
            READY_FRAME,
            {"type": "session-ended", "reason": "max_session_duration"},
            {"type": "transcript", "role": "ASSISTANT", "text": "still here", "is_final": True},
        )
        ready, transcript = await _collect(session, 2)
        assert isinstance(ready, ReadyEvent)
        assert isinstance(transcript, TranscriptDeltaEvent)
        assert transcript.text == "still here"
        assert session.state.kind is SessionStateKind.CONNECTED

        harness.transport.simulate_closed("SIGNAL_CLOSE")
        events = [event async for event in session]
        assert len(events) == 1
        assert isinstance(events[0], SessionEndedEvent)
        assert events[0].reason == "max_session_duration"
        assert session.state.disconnect_reason is DisconnectReason.SERVER_ENDED

    asyncio.run(scenario())


def test_lifecycle_transitions_are_logged() -> None:
    # A dropped-call RCA must be possible from logs alone: every state
    # transition emits one structured event carrying the disconnect reason.
    async def scenario() -> None:
        with structlog.testing.capture_logs() as logs:
            harness = await start_fake_session()
            session = harness.session
            assert session is not None
            await session.end()
        events = [
            (log["kind"], log.get("disconnect_reason"))
            for log in logs
            if log["event"] == "realtime.session_state_changed"
        ]
        assert events == [
            ("connecting", None),
            ("connected", None),
            ("disconnected", "client_ended"),
        ]

    asyncio.run(scenario())


def test_deliberate_server_close_maps_to_server_ended() -> None:
    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None
        harness.transport.simulate_closed("ROOM_DELETED", kind="server_ended")
        events = [event async for event in session]
        assert len(events) == 1
        assert isinstance(events[0], SessionEndedEvent)
        assert events[0].reason == "ROOM_DELETED"
        assert session.state.disconnect_reason is DisconnectReason.SERVER_ENDED

    asyncio.run(scenario())


def test_close_synthesizes_client_closed_terminal_without_end_frame() -> None:
    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None
        await session.close()
        assert harness.frames == []
        events = [event async for event in session]
        assert len(events) == 1
        assert isinstance(events[0], SessionEndedEvent)
        assert events[0].reason == "client closed"
        assert session.state.disconnect_reason is DisconnectReason.CLIENT_CLOSED

    asyncio.run(scenario())


def test_end_sends_end_frame_and_synthesizes_terminal_event() -> None:
    async def scenario() -> None:
        states: list[RealtimeSessionState] = []
        harness = await start_fake_session(on_state_change=states.append)
        session = harness.session
        assert session is not None
        await session.end()
        await session.end()  # idempotent
        assert [frame["type"] for frame in harness.frames] == ["end"]
        events = [event async for event in session]
        assert len(events) == 1
        assert isinstance(events[0], SessionEndedEvent)
        assert events[0].reason == "client ended"
        assert states[-1].disconnect_reason is DisconnectReason.CLIENT_ENDED
        assert harness.transport.disconnected is True

    asyncio.run(scenario())


def test_send_methods_emit_external_wire_shapes() -> None:
    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None
        await session.send_text("hello")
        await session.set_muted(True)
        await session.ping()
        text, mute, ping = harness.frames
        assert text["type"] == "send-text"
        assert text["content"] == "hello"
        assert mute["type"] == "mute"
        assert mute["muted"] is True
        assert ping["type"] == "ping"
        for frame in harness.frames:
            assert isinstance(frame["id"], str) and frame["id"]

    asyncio.run(scenario())


def test_send_context_rides_its_own_frame_not_a_text_turn() -> None:
    """A context note must not reach the wire as ``send-text``: that frame is
    a turn, and the model answers turns."""

    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None
        await session.send_context("now on References (section 6 of 7).")
        (frame,) = harness.frames
        assert frame["type"] == "send-context"
        assert frame["content"] == "now on References (section 6 of 7)."
        assert "options" not in frame

    asyncio.run(scenario())


def test_version_mismatch_rejection_raises_typed_error() -> None:
    async def scenario() -> None:
        def respond(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                400,
                json={
                    "detail": {
                        "code": "version_mismatch",
                        "message": "client speaks an incompatible version",
                    }
                },
            )

        states: list[RealtimeSessionState] = []
        with pytest.raises(VersionMismatchError) as excinfo:
            await start_fake_session(respond=respond, on_state_change=states.append)
        assert "version_mismatch" in str(excinfo.value)
        assert excinfo.value.code == "version_mismatch"
        assert [state.kind for state in states] == [
            SessionStateKind.CONNECTING,
            SessionStateKind.DISCONNECTED,
        ]
        assert states[-1].disconnect_reason is DisconnectReason.HANDSHAKE_FAILED

    asyncio.run(scenario())


@pytest.mark.parametrize("verb", ["text", "byte"])
@pytest.mark.parametrize("topic", ["lk.agent.session", "lk.transcription", "lk.foo"])
def test_expected_livekit_native_stream_logs_are_dropped(verb: str, topic: str) -> None:
    filt = _IgnoredLivekitStreamFilter()
    assert filt.filter(_stream_ignore_record(verb, topic)) is False


@pytest.mark.parametrize("verb", ["text", "byte"])
def test_unexpected_stream_topic_still_logs(verb: str) -> None:
    filt = _IgnoredLivekitStreamFilter()
    assert filt.filter(_stream_ignore_record(verb, "app.custom.stream")) is True


def test_unrelated_records_pass_through_the_filter() -> None:
    filt = _IgnoredLivekitStreamFilter()
    record = logging.LogRecord(
        name="root",
        level=logging.INFO,
        pathname=__file__,
        lineno=0,
        msg="connecting to %s",
        args=("lk.transcription",),
        exc_info=None,
    )
    assert filt.filter(record) is True


def test_quiet_expected_livekit_streams_installs_one_filter_idempotently(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from cosmo_ai.session import _livekit as transport_module

    root = logging.getLogger()
    preexisting = [
        f for f in root.filters if isinstance(f, _IgnoredLivekitStreamFilter)
    ]
    for f in preexisting:
        root.removeFilter(f)
    monkeypatch.setattr(transport_module, "_lk_stream_filter_installed", False)
    try:
        _quiet_expected_livekit_streams()
        _quiet_expected_livekit_streams()
        installed = [
            f for f in root.filters if isinstance(f, _IgnoredLivekitStreamFilter)
        ]
        assert len(installed) == 1
        assert root.filter(_stream_ignore_record("text", "lk.transcription")) is False
    finally:
        for f in [
            f for f in root.filters if isinstance(f, _IgnoredLivekitStreamFilter)
        ]:
            root.removeFilter(f)
        for f in preexisting:
            root.addFilter(f)


def test_send_bind_input_emits_frame_and_marks_bound() -> None:
    """Publishing audio claims the agent's input: a bare ``bind-input`` frame is
    sent and the session records that it is the voice (for reconnect re-binds)."""

    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None

        await session._send_bind_input()

        assert session._input_bound is True
        (frame,) = harness.frames
        assert frame["type"] == "bind-input"
        assert isinstance(frame["id"], str) and frame["id"]

    asyncio.run(scenario())


def test_send_bind_input_is_best_effort_on_publish_failure() -> None:
    """A transient data-channel failure must not propagate out of the bind send
    (which would abort an otherwise-successful publish); the session still marks
    itself the voice so the reconnect re-bind fires."""

    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None

        async def boom(_message: Any) -> None:
            raise RuntimeError("data channel is not open")

        with mock.patch.object(session, "_publish", boom):
            await session._send_bind_input()  # must not raise

        assert session._input_bound is True
        assert harness.frames == []  # the publish failed, nothing on the wire

    asyncio.run(scenario())


def test_reconnect_re_sends_bind_input_when_bound() -> None:
    """The one-shot bind doesn't survive a transport drop; a reconnect re-asserts
    it when this client is the voice."""

    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None
        await session._send_bind_input()
        harness.frames.clear()

        harness.transport.simulate_reconnected()
        for _ in range(5):  # let the spawned re-bind task run
            await asyncio.sleep(0)

        assert [f["type"] for f in harness.frames] == ["bind-input"]

    asyncio.run(scenario())


def test_reconnect_re_asserts_mute_state() -> None:
    """The server-side mic gate is transport-session state; a reconnect
    re-asserts the last state this client set."""

    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None
        await session.set_muted(True)
        harness.frames.clear()

        harness.transport.simulate_reconnected()
        for _ in range(5):  # let the spawned re-assert task run
            await asyncio.sleep(0)

        assert [(f["type"], f["muted"]) for f in harness.frames] == [("mute", True)]

    asyncio.run(scenario())


def test_session_ended_without_room_close_finishes_after_grace(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import cosmo_ai.session._engine as engine

    monkeypatch.setattr(engine, "_SESSION_ENDED_GRACE_SECONDS", 0.01)

    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None
        await _inject(
            session,
            READY_FRAME,
            {"type": "session-ended", "reason": "worker done"},
        )

        # No room close follows — the grace timer must finish the stream.
        async def drain() -> list[Any]:
            return [event async for event in session]

        seen = await asyncio.wait_for(drain(), timeout=2)
        ended = [e for e in seen if isinstance(e, SessionEndedEvent)]
        assert len(ended) == 1
        assert ended[0].reason == "worker done"
        assert session.state.kind is SessionStateKind.DISCONNECTED
        assert session.state.disconnect_reason is DisconnectReason.SERVER_ENDED

    asyncio.run(scenario())


def test_reconnect_does_not_bind_when_client_is_not_the_voice() -> None:
    """A client that never published audio (never bound) must not claim the
    input on reconnect."""

    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None

        harness.transport.simulate_reconnected()
        for _ in range(5):
            await asyncio.sleep(0)

        assert harness.frames == []

    asyncio.run(scenario())
