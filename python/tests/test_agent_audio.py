"""RealtimeSession.agent_audio(): typed frames through the fake transport,
lazy sink attach/detach, and end-of-session finish."""

from __future__ import annotations

import asyncio

from cosmo_ai.audio import AgentAudioFrame

from tests.fakes import start_fake_session

def _frame(tag: int) -> AgentAudioFrame:
    return AgentAudioFrame(
        data=bytes([tag]) * 960,
        sample_rate=48000,
        num_channels=1,
        samples_per_channel=480,
    )


def test_agent_audio_yields_frames_and_manages_sink() -> None:
    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None
        assert harness.transport.agent_audio_sink is None  # lazy until consumed

        got: list[AgentAudioFrame] = []

        async def consume() -> None:
            gen = session.agent_audio()
            async for frame in gen:
                got.append(frame)
                if len(got) == 2:
                    break
            await gen.aclose()  # deterministic detach — don't rely on GC timing

        task = asyncio.create_task(consume())
        for _ in range(5):
            await asyncio.sleep(0)
        assert harness.transport.agent_audio_sink is session._broadcaster
        harness.transport.simulate_agent_audio(_frame(1))
        harness.transport.simulate_agent_audio(_frame(2))
        await task
        assert [f.data[0] for f in got] == [1, 2]
        assert got[0].sample_rate == 48000
        for _ in range(5):
            await asyncio.sleep(0)
        assert harness.transport.agent_audio_sink is None  # detached at 0 consumers
        await session.end()

    asyncio.run(scenario())


def test_two_iterators_each_get_every_frame() -> None:
    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None
        a: list[int] = []
        b: list[int] = []

        async def consume(into: list[int]) -> None:
            async for frame in session.agent_audio():
                into.append(frame.data[0])

        ta = asyncio.create_task(consume(a))
        tb = asyncio.create_task(consume(b))
        for _ in range(5):
            await asyncio.sleep(0)
        harness.transport.simulate_agent_audio(_frame(7))
        for _ in range(5):
            await asyncio.sleep(0)
        await session.end()
        await ta
        await tb
        assert a == [7]
        assert b == [7]

    asyncio.run(scenario())


def test_session_end_finishes_iterator() -> None:
    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None

        async def consume() -> list[AgentAudioFrame]:
            return [frame async for frame in session.agent_audio()]

        task = asyncio.create_task(consume())
        for _ in range(5):
            await asyncio.sleep(0)
        await session.end()
        assert await task == []

    asyncio.run(scenario())


def test_audio_types_live_under_the_audio_module_not_the_root() -> None:
    import cosmo_ai
    from cosmo_ai import audio

    assert audio.AgentAudioFrame is AgentAudioFrame
    assert audio.AudioLevels(mic=0.0, agent=0.0).agent == 0.0
    # advanced-path types stay out of the root namespace
    assert "AgentAudioFrame" not in cosmo_ai.__all__
    assert "AudioLevels" not in cosmo_ai.__all__
