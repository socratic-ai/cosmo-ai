"""Engine-level speaker wiring: set_speaker_enabled / set_agent_playback_volume
against the fake transport with sounddevice stubbed."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

import cosmo_ai.audio._sounddevice as sdgate

from tests.fakes import start_fake_session


class _FakeStream:
    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs
        self.closed = False

    def start(self) -> None:
        pass

    def stop(self) -> None:
        pass

    def close(self) -> None:
        self.closed = True


class _FakeSd:
    def __init__(self) -> None:
        self.streams: list[_FakeStream] = []

    def RawOutputStream(self, **kwargs: Any) -> _FakeStream:
        stream = _FakeStream(**kwargs)
        self.streams.append(stream)
        return stream


def test_speaker_enable_disable_wires_sink_and_device(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def scenario() -> None:
        fake_sd = _FakeSd()
        monkeypatch.setattr(sdgate, "ensure_sounddevice", lambda: fake_sd)
        harness = await start_fake_session()
        session = harness.session
        assert session is not None

        await session.set_speaker_enabled(True)
        await session.set_speaker_enabled(True)  # idempotent
        for _ in range(5):
            await asyncio.sleep(0)
        assert len(fake_sd.streams) == 1
        assert harness.transport.agent_audio_sink is session._broadcaster

        await session.set_speaker_enabled(False)
        for _ in range(5):
            await asyncio.sleep(0)
        assert fake_sd.streams[0].closed is True
        assert harness.transport.agent_audio_sink is None
        await session.set_speaker_enabled(False)  # idempotent
        await session.end()

    asyncio.run(scenario())


def test_speaker_broken_sounddevice_raises_before_subscribing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def scenario() -> None:
        def _boom() -> Any:
            raise OSError("PortAudio library not found")

        monkeypatch.setattr(sdgate, "ensure_sounddevice", _boom)
        harness = await start_fake_session()
        session = harness.session
        assert session is not None
        with pytest.raises(OSError):
            await session.set_speaker_enabled(True)
        assert harness.transport.agent_audio_sink is None
        await session.end()

    asyncio.run(scenario())


def test_playback_volume_is_clamped_stored_and_forwarded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def scenario() -> None:
        fake_sd = _FakeSd()
        monkeypatch.setattr(sdgate, "ensure_sounddevice", lambda: fake_sd)
        harness = await start_fake_session()
        session = harness.session
        assert session is not None

        session.set_agent_playback_volume(2.0)  # before the speaker exists
        await session.set_speaker_enabled(True)
        assert session._speaker is not None
        assert session._speaker._volume == 1.0  # clamped, applied at start
        session.set_agent_playback_volume(0.25)
        assert session._speaker._volume == 0.25
        await session.end()

    asyncio.run(scenario())


def test_session_end_tears_down_speaker(monkeypatch: pytest.MonkeyPatch) -> None:
    async def scenario() -> None:
        fake_sd = _FakeSd()
        monkeypatch.setattr(sdgate, "ensure_sounddevice", lambda: fake_sd)
        harness = await start_fake_session()
        session = harness.session
        assert session is not None
        await session.set_speaker_enabled(True)
        await session.end()
        assert fake_sd.streams[0].closed is True
        assert session._speaker is None

    asyncio.run(scenario())


def test_playback_volume_rejects_nan() -> None:
    async def scenario() -> None:
        harness = await start_fake_session()
        session = harness.session
        assert session is not None
        with pytest.raises(ValueError):
            session.set_agent_playback_volume(float("nan"))
        await session.end()

    asyncio.run(scenario())
