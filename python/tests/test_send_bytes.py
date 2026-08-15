"""``LiveKitTransport.send_bytes``: a binary payload rides a LiveKit byte
stream targeted to the agent participant(s) only — never the reliable data
channel and never broadcast to the room. Mirrors the Python/Swift/TypeScript
SDKs' agent-targeted byte-stream primitive, the transport half of the screen
locator's capture handoff.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

import livekit.rtc as rtc
import pytest
from cosmo_ai.errors import NotConnectedError
from cosmo_ai.session._livekit import LiveKitTransport

_AGENT = rtc.ParticipantKind.PARTICIPANT_KIND_AGENT
_HUMAN = rtc.ParticipantKind.PARTICIPANT_KIND_STANDARD


@dataclass
class _FakeParticipant:
    identity: str
    kind: Any


class _FakeWriter:
    def __init__(
        self, writes: list[bytes], closed: list[bool], *, fail_write: bool = False
    ) -> None:
        self._writes = writes
        self._closed = closed
        self._fail_write = fail_write

    async def write(self, data: bytes) -> None:
        if self._fail_write:
            raise RuntimeError("stream write boom")
        self._writes.append(data)

    async def aclose(self, *, reason: str = "", attributes: Any = None) -> None:
        self._closed.append(True)


@dataclass
class _FakeLocalParticipant:
    fail_write: bool = False
    calls: list[dict[str, Any]] = field(default_factory=list)
    writes: list[bytes] = field(default_factory=list)
    closed: list[bool] = field(default_factory=list)

    async def stream_bytes(
        self, *, name: str, topic: str, destination_identities: list[str]
    ) -> _FakeWriter:
        self.calls.append(
            {
                "name": name,
                "topic": topic,
                "destination_identities": destination_identities,
            }
        )
        return _FakeWriter(self.writes, self.closed, fail_write=self.fail_write)


class _FakeRoom:
    def __init__(self, *participants: _FakeParticipant, fail_write: bool = False) -> None:
        self.remote_participants = {p.identity: p for p in participants}
        self.local_participant = _FakeLocalParticipant(fail_write=fail_write)

    def isconnected(self) -> bool:
        return True


def _connected(*participants: _FakeParticipant, fail_write: bool = False) -> LiveKitTransport:
    transport = LiveKitTransport()
    transport._room = _FakeRoom(*participants, fail_write=fail_write)
    return transport


def test_send_bytes_targets_the_agent_only_and_writes_then_closes() -> None:
    async def scenario() -> None:
        transport = _connected(
            _FakeParticipant("agent-1", _AGENT),
            _FakeParticipant("human-1", _HUMAN),
        )
        await transport.send_bytes(b"\x01\x02\x03", "screen_capture")

        lp = transport._room.local_participant
        assert lp.calls == [
            {
                "name": "screen_capture",
                "topic": "screen_capture",
                "destination_identities": ["agent-1"],
            }
        ]
        assert lp.writes == [b"\x01\x02\x03"]
        assert lp.closed == [True]

    asyncio.run(scenario())


def test_send_bytes_targets_every_agent_when_more_than_one_is_present() -> None:
    async def scenario() -> None:
        transport = _connected(
            _FakeParticipant("agent-1", _AGENT),
            _FakeParticipant("agent-2", _AGENT),
            _FakeParticipant("human-1", _HUMAN),
        )
        await transport.send_bytes(b"\x09", "screen_capture")

        assert transport._room.local_participant.calls[0]["destination_identities"] == [
            "agent-1",
            "agent-2",
        ]

    asyncio.run(scenario())


def test_send_bytes_rejects_and_opens_no_stream_when_no_agent_is_present() -> None:
    async def scenario() -> None:
        transport = _connected(_FakeParticipant("human-1", _HUMAN))
        with pytest.raises(NotConnectedError, match="no agent participant"):
            await transport.send_bytes(b"\x01", "screen_capture")
        assert transport._room.local_participant.calls == []

    asyncio.run(scenario())


def test_send_bytes_rejects_when_not_connected() -> None:
    async def scenario() -> None:
        transport = LiveKitTransport()
        with pytest.raises(NotConnectedError):
            await transport.send_bytes(b"\x01", "screen_capture")

    asyncio.run(scenario())


def test_send_bytes_closes_the_writer_even_when_the_write_fails() -> None:
    async def scenario() -> None:
        transport = _connected(_FakeParticipant("agent-1", _AGENT), fail_write=True)
        with pytest.raises(RuntimeError, match="stream write boom"):
            await transport.send_bytes(b"\x01", "screen_capture")
        assert transport._room.local_participant.closed == [True]

    asyncio.run(scenario())
