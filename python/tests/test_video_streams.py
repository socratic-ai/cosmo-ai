"""The session's video-stream surface: publishing pixels that are not the
user's screen, and the handle frames are pushed through."""

from __future__ import annotations

import asyncio

import pytest

from cosmo_ai.errors import NotConnectedError
from cosmo_ai.session import VideoStreamHandle

from .fakes import start_fake_session


def test_the_handle_routes_frames_to_the_stream_it_opened() -> None:
    async def scenario() -> None:
        harness = await start_fake_session()
        stream = await harness.session.add_video_stream()
        assert isinstance(stream, VideoStreamHandle)

        stream.push("frame-1")
        stream.push("frame-2")
        assert harness.transport.video_frames == [
            (stream.stream_id, "frame-1"),
            (stream.stream_id, "frame-2"),
        ]

    asyncio.run(scenario())


def test_two_streams_push_into_their_own_publishes() -> None:
    # The id travels with the handle, so an app holding both never has to
    # reason about which one the SDK thinks is current.
    async def scenario() -> None:
        harness = await start_fake_session()
        first = await harness.session.add_video_stream()
        await harness.session.remove_video_stream(first)
        second = await harness.session.add_video_stream()

        first.push("stale")
        second.push("live")
        assert harness.transport.video_frames == [
            (first.stream_id, "stale"),
            (second.stream_id, "live"),
        ]
        assert first.stream_id != second.stream_id

    asyncio.run(scenario())


def test_removing_a_stream_is_idempotent() -> None:
    async def scenario() -> None:
        harness = await start_fake_session()
        stream = await harness.session.add_video_stream()
        await harness.session.remove_video_stream(stream)
        await harness.session.remove_video_stream(stream)
        assert harness.transport.video_streams == []

    asyncio.run(scenario())


def test_adding_a_stream_before_the_session_is_live_fails_loudly() -> None:
    # Without the guard the track exists and frames are captured into a sink
    # that never publishes — a silent failure the caller cannot see.
    from cosmo_ai.session._engine import RealtimeSession

    async def scenario() -> None:
        session = RealtimeSession.__new__(RealtimeSession)
        session._transport = None  # type: ignore[attr-defined]
        with pytest.raises(NotConnectedError):
            await session.add_video_stream()

    asyncio.run(scenario())
