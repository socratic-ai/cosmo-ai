"""One voice per session: the microphone and a caller-owned audio stream are
mutually exclusive, and only one stream publishes at a time.

Two tracks both claiming the session's voice leave the agent — and the server
mute gate — picking between them arbitrarily, so the second publish is refused
rather than allowed to create that state."""

from __future__ import annotations

import asyncio

import pytest

from cosmo_ai import AudioPublishAlreadyActiveError

from tests.fakes import start_fake_session


def test_start_audio_stream_publishes() -> None:
    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None

        await session.start_audio_stream(object())

        assert len(harness.transport.published_sources) == 1
        await session.end()

    asyncio.run(scenario())


def test_second_stream_is_refused() -> None:
    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None
        await session.start_audio_stream(object())

        with pytest.raises(AudioPublishAlreadyActiveError):
            await session.start_audio_stream(object())

        # The refusal happens before publishing, so no second track exists.
        assert len(harness.transport.published_sources) == 1
        await session.end()

    asyncio.run(scenario())


def test_a_stream_is_accepted_once_the_running_one_stops() -> None:
    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None
        await session.start_audio_stream(object())
        await session.stop_audio_stream()

        await session.start_audio_stream(object())

        assert len(harness.transport.published_sources) == 2
        await session.end()

    asyncio.run(scenario())


def test_stop_unpublishes_and_closes_the_server_gate() -> None:
    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None
        await session.start_audio_stream(object())

        await session.stop_audio_stream()

        assert len(harness.transport.unpublished) == 1
        # The session has no voice now; leaving the gate open would let a
        # later publish be heard before the caller intended.
        mutes = [f for f in harness.frames if f["type"] == "mute"]
        assert mutes[-1]["muted"] is True
        await session.end()

    asyncio.run(scenario())


def test_stop_is_idempotent() -> None:
    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None
        await session.start_audio_stream(object())

        await session.stop_audio_stream()
        await session.stop_audio_stream()
        await session.stop_audio_stream()

        assert len(harness.transport.unpublished) == 1
        await session.end()

    asyncio.run(scenario())


def test_microphone_is_refused_while_a_stream_publishes() -> None:
    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None
        await session.start_audio_stream(object())

        with pytest.raises(AudioPublishAlreadyActiveError):
            await session.set_microphone_enabled(True)

        assert len(harness.transport.published_sources) == 1
        await session.end()

    asyncio.run(scenario())
