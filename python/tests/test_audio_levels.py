"""RealtimeSession.audio_levels(): cadence-sampled RMS from the mic slot and
the agent frame path; finishes at session end."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

import cosmo_ai.session._engine as engmod
from cosmo_ai.audio import AgentAudioFrame, AudioLevels

from tests.fakes import start_fake_session


@pytest.fixture(autouse=True)
def _fast_cadence(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(engmod, "_LEVELS_INTERVAL_SECONDS", 0.001)
    monkeypatch.setattr(engmod, "_AGENT_LEVEL_STALE_SECONDS", 0.02)


def _agent_frame() -> AgentAudioFrame:
    half_scale = (16384).to_bytes(2, "little", signed=True)
    return AgentAudioFrame(
        data=half_scale * 480,
        sample_rate=48000,
        num_channels=1,
        samples_per_channel=480,
    )


def test_levels_reflect_agent_frames_and_idle_mic() -> None:
    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None
        samples: list[AudioLevels] = []

        async def consume() -> None:
            async for levels in session.audio_levels():
                samples.append(levels)
                if len(samples) >= 3:
                    return

        task = asyncio.create_task(consume())
        for _ in range(5):
            await asyncio.sleep(0)
        assert harness.transport.agent_audio_sink is session._broadcaster
        harness.transport.simulate_agent_audio(_agent_frame())
        await task
        assert samples[0].mic == 0.0  # mic never enabled
        assert any(abs(s.agent - 0.5) < 0.01 for s in samples)
        await session.end()

    asyncio.run(scenario())


def test_levels_read_mic_slot_when_mic_active() -> None:
    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None

        async def _read_level() -> float:
            return 0.7

        # The engine samples the mic through read_level() and nothing else.
        session._mic = SimpleNamespace(read_level=_read_level)

        async def first() -> AudioLevels:
            async for levels in session.audio_levels():
                return levels
            raise AssertionError("no sample yielded")

        sample = await first()
        assert sample.mic == 0.7
        session._mic = None
        await session.end()

    asyncio.run(scenario())


def test_levels_finish_at_session_end() -> None:
    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None

        async def consume() -> int:
            count = 0
            async for _ in session.audio_levels():
                count += 1
            return count

        task = asyncio.create_task(consume())
        await asyncio.sleep(0.01)
        await session.end()
        count = await asyncio.wait_for(task, timeout=1.0)
        assert count >= 0  # iterator terminated — the assertion is no timeout

    asyncio.run(scenario())


def test_agent_level_decays_to_zero_when_frames_stop() -> None:
    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None
        samples: list[AudioLevels] = []

        async def consume() -> None:
            async for levels in session.audio_levels():
                samples.append(levels)
                if any(s.agent > 0.4 for s in samples) and samples[-1].agent == 0.0:
                    return
                if len(samples) > 500:
                    raise AssertionError(f"never decayed: {samples[-5:]}")

        task = asyncio.create_task(consume())
        for _ in range(5):
            await asyncio.sleep(0)
        harness.transport.simulate_agent_audio(_agent_frame())
        await asyncio.wait_for(task, timeout=5.0)
        assert any(abs(s.agent - 0.5) < 0.01 for s in samples)  # heard the frame
        assert samples[-1].agent == 0.0  # then decayed on silence
        await session.end()

    asyncio.run(scenario())
