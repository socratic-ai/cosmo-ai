"""Integration tests: SessionStart hooks fire before handshake and fold
additional_context into the session instructions sent to the server."""

from __future__ import annotations

import json

import httpx
import pytest

from cosmo_ai.errors import SessionStartError
from cosmo_ai.hooks import (
    SessionStartContext,
    SessionStartResult,
    SessionEndContext,
    session_end,
    session_start,
)
from cosmo_ai.session import DisconnectReason

from .fakes import start_fake_session


@pytest.mark.asyncio
async def test_session_start_context_appended_to_sent_instructions():
    @session_start
    def vip(ctx: SessionStartContext) -> SessionStartResult:
        return SessionStartResult(additional_context="Caller is a VIP.")

    harness = await start_fake_session(instructions="You are Alex.", hooks=[vip])
    sent = harness.start_bodies[0]
    assert sent["agent"]["instructions"] == "You are Alex.\n\nCaller is a VIP."


@pytest.mark.asyncio
async def test_session_start_no_context_leaves_instructions_unchanged():
    @session_start
    def noop(ctx: SessionStartContext) -> None:
        return None

    harness = await start_fake_session(instructions="You are Alex.", hooks=[noop])
    assert harness.start_bodies[0]["agent"]["instructions"] == "You are Alex."


@pytest.mark.asyncio
async def test_stop_fires_once_on_normal_end():
    stops: list[SessionEndContext] = []

    @session_end
    def on_session_end(ctx: SessionEndContext) -> None:
        stops.append(ctx)

    harness = await start_fake_session(instructions="hi", hooks=[on_session_end])
    assert harness.session is not None
    await harness.session.end()
    await harness.session.end()  # idempotent

    assert len(stops) == 1
    assert stops[0].reason == DisconnectReason.CLIENT_ENDED
    assert stops[0].session_id == "sess-test"


@pytest.mark.asyncio
async def test_session_start_empty_hooks_leave_instructions_unchanged():
    harness = await start_fake_session(instructions="You are Alex.", hooks=[])
    assert harness.start_bodies[0]["agent"]["instructions"] == "You are Alex."


@pytest.mark.asyncio
async def test_stop_fires_on_handshake_failure():
    stops: list[SessionEndContext] = []

    @session_end
    def on_session_end(ctx: SessionEndContext) -> None:
        stops.append(ctx)

    def reject(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"detail": {"code": "boom", "message": "no"}})

    with pytest.raises(SessionStartError):
        await start_fake_session(instructions="hi", hooks=[on_session_end], respond=reject)

    assert len(stops) == 1
    assert stops[0].reason == DisconnectReason.HANDSHAKE_FAILED
    assert stops[0].session_id is None


@pytest.mark.asyncio
async def test_stop_fires_when_session_start_hook_fold_raises():
    """A SessionStart hook whose result can't be folded (e.g. non-str
    additional_context) must still fire Stop, not escape _start() silently."""
    stops: list[SessionEndContext] = []

    @session_end
    def on_session_end(ctx: SessionEndContext) -> None:
        stops.append(ctx)

    @session_start
    def bad(ctx: SessionStartContext) -> SessionStartResult:
        return SessionStartResult(additional_context=123)  # type: ignore[arg-type]

    with pytest.raises(SessionStartError) as exc_info:
        await start_fake_session(instructions="hi", hooks=[on_session_end, bad])

    assert exc_info.value.code == "session_start_hook_failed"
    assert len(stops) == 1
    assert stops[0].reason == DisconnectReason.HANDSHAKE_FAILED
    assert stops[0].session_id is None


@pytest.mark.asyncio
async def test_session_start_context_not_injected_into_catalog_agent():
    """A catalog agent runs its stored config verbatim — SessionStart
    additional_context is dropped (with a warning), never sent as
    instructions alongside the name."""

    @session_start
    def vip(ctx: SessionStartContext) -> SessionStartResult:
        return SessionStartResult(additional_context="Caller is a VIP.")

    harness = await start_fake_session(name="driver-pay", hooks=[vip])
    sent = harness.start_bodies[0]
    assert sent["agent"]["type"] == "catalog"
    assert "instructions" not in sent["agent"]


@pytest.mark.asyncio
async def test_session_end_reports_server_ended_for_deliberate_close():
    ends: list[SessionEndContext] = []

    @session_end
    def on_session_end(ctx: SessionEndContext) -> None:
        ends.append(ctx)

    harness = await start_fake_session(instructions="hi", hooks=[on_session_end])
    assert harness.session is not None
    harness.transport.simulate_closed("ROOM_DELETED", kind="server_ended")
    _ = [event async for event in harness.session]

    assert len(ends) == 1
    assert ends[0].reason is DisconnectReason.SERVER_ENDED
    assert ends[0].detail == "ROOM_DELETED"


@pytest.mark.asyncio
async def test_session_end_latched_server_reason_wins_over_close_kind():
    ends: list[SessionEndContext] = []

    @session_end
    def on_session_end(ctx: SessionEndContext) -> None:
        ends.append(ctx)

    harness = await start_fake_session(instructions="hi", hooks=[on_session_end])
    assert harness.session is not None
    harness.transport.simulate_frame(
        json.dumps({"type": "session-ended", "reason": "user_ended"}).encode()
    )
    harness.transport.simulate_closed("SIGNAL_CLOSE")
    _ = [event async for event in harness.session]

    assert len(ends) == 1
    assert ends[0].reason is DisconnectReason.SERVER_ENDED
    assert ends[0].detail == "user_ended"
