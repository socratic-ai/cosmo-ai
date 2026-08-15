"""AgentAudioBroadcaster fan-out and RMS math — pure logic, no LiveKit."""

from __future__ import annotations

import asyncio

from cosmo_ai.audio import AgentAudioFrame
from cosmo_ai.audio._broadcast import (
    _CONSUMER_QUEUE_MAX_FRAMES,
    AgentAudioBroadcaster,
    rms_int16,
)


def _frame(tag: int) -> AgentAudioFrame:
    return AgentAudioFrame(
        data=bytes([tag % 256]) * 960,
        sample_rate=48000,
        num_channels=1,
        samples_per_channel=480,
    )


def _broadcaster(events: list[str]) -> AgentAudioBroadcaster:
    return AgentAudioBroadcaster(
        on_first_consumer=lambda: events.append("first"),
        on_last_consumer=lambda: events.append("last"),
    )


def test_every_consumer_gets_every_frame() -> None:
    async def scenario() -> None:
        bc = _broadcaster([])
        a, b = bc.subscribe(), bc.subscribe()
        bc.deliver(_frame(1))
        bc.deliver(_frame(2))
        bc.close()
        got_a = [f async for f in a]
        got_b = [f async for f in b]
        assert [f.data[0] for f in got_a] == [1, 2]
        assert got_b == got_a

    asyncio.run(scenario())


def test_activation_callbacks_fire_on_edge_transitions_only() -> None:
    async def scenario() -> None:
        events: list[str] = []
        bc = _broadcaster(events)
        a = bc.subscribe()
        b = bc.subscribe()
        assert events == ["first"]
        bc.unsubscribe(a)
        assert events == ["first"]
        bc.unsubscribe(b)
        assert events == ["first", "last"]
        bc.unsubscribe(b)  # double-unsubscribe is a no-op
        assert events == ["first", "last"]

    asyncio.run(scenario())


def test_stalled_consumer_drops_oldest_frames() -> None:
    async def scenario() -> None:
        bc = _broadcaster([])
        consumer = bc.subscribe()
        for tag in range(_CONSUMER_QUEUE_MAX_FRAMES + 3):
            bc.deliver(_frame(tag))
        bc.close()
        got = [f.data[0] for f in [f async for f in consumer]]
        # 203 delivered into a 200-slot queue: 0..2 evicted oldest-first, then
        # the finish sentinel evicts one more (it must always land).
        assert len(got) == _CONSUMER_QUEUE_MAX_FRAMES - 1
        assert got[0] == 4
        assert got[-1] == (_CONSUMER_QUEUE_MAX_FRAMES + 2) % 256

    asyncio.run(scenario())


def test_close_finishes_iterators_and_new_subscribers() -> None:
    async def scenario() -> None:
        events: list[str] = []
        bc = _broadcaster(events)
        live = bc.subscribe()
        bc.close()
        assert [f async for f in live] == []
        late = bc.subscribe()
        assert [f async for f in late] == []
        # a closed broadcaster never re-activates the pipeline
        assert events == ["first"]

    asyncio.run(scenario())


def test_rms_int16_known_signals() -> None:
    assert rms_int16(b"") == 0.0
    assert rms_int16(b"\x00\x00" * 480) == 0.0
    full_scale = (32767).to_bytes(2, "little", signed=True) * 480
    assert rms_int16(full_scale) > 0.99
    half_scale = (16384).to_bytes(2, "little", signed=True) * 480
    assert abs(rms_int16(half_scale) - 0.5) < 0.01
