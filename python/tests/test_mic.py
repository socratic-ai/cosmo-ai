"""MicAudioSource over WebRTC's Audio Device Module: the capture policy that
reaches LiveKit, device-handle release, and the statistic the level is read
from since the ADM hands Python no frames. LiveKit is stubbed here — that
livekit actually reports the statistic is pinned by
``test_live_audio_levels.py`` against a real server."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any

import pytest

import cosmo_ai.audio._mic as micmod
from cosmo_ai.audio import MicrophoneCapture
from cosmo_ai.errors import AudioUnavailableError


@dataclass
class _FakeOptions:
    echo_cancellation: bool
    noise_suppression: bool
    auto_gain_control: bool


class _FakeSource:
    def __init__(self) -> None:
        self.closed = False

    def close(self) -> None:
        self.closed = True


class _FakePlatformAudio:
    created: list[_FakePlatformAudio] = []
    fail_on_init = False
    fail_on_source = False

    def __init__(self) -> None:
        if type(self).fail_on_init:
            raise RuntimeError("no audio device")
        self.closed = False
        self.options: Any = None
        self.sources: list[_FakeSource] = []
        type(self).created.append(self)

    def create_audio_source(self, options: Any) -> _FakeSource:
        if type(self).fail_on_source:
            raise RuntimeError("device busy")
        self.options = options
        source = _FakeSource()
        self.sources.append(source)
        return source

    def close(self) -> None:
        self.closed = True


def _stats_entry(kind: str, level: float) -> Any:
    """One `media_source` stats entry in the shape livekit-rtc returns."""
    return SimpleNamespace(
        WhichOneof=lambda _field: "media_source",
        media_source=SimpleNamespace(
            source=SimpleNamespace(kind=kind),
            audio=SimpleNamespace(audio_level=level),
        ),
    )


def _other_entry() -> Any:
    return SimpleNamespace(WhichOneof=lambda _field: "outbound_rtp")


class _FakeTrack:
    """Stands in for the published LocalAudioTrack the level is read from."""

    def __init__(self, *collections: Any) -> None:
        self._collections = list(collections)
        self.calls = 0

    async def get_stats(self) -> Any:
        self.calls += 1
        if not self._collections:
            return []
        if len(self._collections) == 1:
            return self._collections[0]
        return self._collections.pop(0)


@pytest.fixture(autouse=True)
def _stub_rtc(monkeypatch: pytest.MonkeyPatch) -> None:
    _FakePlatformAudio.created = []
    _FakePlatformAudio.fail_on_init = False
    _FakePlatformAudio.fail_on_source = False
    monkeypatch.setattr(
        micmod,
        "rtc",
        SimpleNamespace(
            PlatformAudio=_FakePlatformAudio,
            PlatformAudioOptions=_FakeOptions,
        ),
    )


def test_default_capture_policy_enables_all_three_processors() -> None:
    async def scenario() -> None:
        mic = micmod.MicAudioSource()
        await mic.start()
        options = _FakePlatformAudio.created[0].options
        assert options.echo_cancellation is True
        assert options.noise_suppression is True
        assert options.auto_gain_control is True

    asyncio.run(scenario())


def test_capture_policy_maps_field_by_field() -> None:
    # Each flag must reach its own LiveKit counterpart: a transposed pair here
    # would ship the wrong DSP silently, audible only as a bad call.
    async def scenario() -> None:
        mic = micmod.MicAudioSource(
            MicrophoneCapture(
                echo_cancellation=True,
                noise_suppression=False,
                auto_gain_control=False,
            )
        )
        await mic.start()
        options = _FakePlatformAudio.created[0].options
        assert options.echo_cancellation is True
        assert options.noise_suppression is False
        assert options.auto_gain_control is False

    asyncio.run(scenario())


def test_source_unavailable_before_start() -> None:
    mic = micmod.MicAudioSource()
    with pytest.raises(RuntimeError):
        _ = mic.livekit_source


def test_unopenable_device_raises_and_leaks_no_handle() -> None:
    # A headless host or a denied permission: the ADM came up but the source
    # did not, so the ADM handle must be released rather than stranded.
    async def scenario() -> None:
        _FakePlatformAudio.fail_on_source = True
        mic = micmod.MicAudioSource()
        with pytest.raises(AudioUnavailableError):
            await mic.start()
        assert _FakePlatformAudio.created[0].closed is True

    asyncio.run(scenario())


def test_adm_init_failure_raises() -> None:
    async def scenario() -> None:
        _FakePlatformAudio.fail_on_init = True
        mic = micmod.MicAudioSource()
        with pytest.raises(AudioUnavailableError):
            await mic.start()

    asyncio.run(scenario())


def test_stop_releases_source_and_adm() -> None:
    # The ADM holds a native device handle; a GC-timed release blocks the next
    # capture on Windows, so both handles close deterministically.
    async def scenario() -> None:
        mic = micmod.MicAudioSource()
        await mic.start()
        platform = _FakePlatformAudio.created[0]
        source = platform.sources[0]
        await mic.stop()
        assert source.closed is True
        assert platform.closed is True

    asyncio.run(scenario())


def test_stop_is_idempotent() -> None:
    async def scenario() -> None:
        mic = micmod.MicAudioSource()
        await mic.start()
        await mic.stop()
        await mic.stop()

    asyncio.run(scenario())


def test_level_comes_from_the_audio_source_stats() -> None:
    async def scenario() -> None:
        mic = micmod.MicAudioSource()
        await mic.start()
        assert mic.level == 0.0
        mic.set_level_source(_FakeTrack([_stats_entry("audio", 0.42)]))
        assert await mic.read_level() == pytest.approx(0.42)
        await mic.stop()

    asyncio.run(scenario())


def test_level_ignores_the_video_source_of_a_session_publishing_both() -> None:
    # A session sharing its screen reports several media sources. Reading the
    # first one would meter the video track and report silence forever.
    async def scenario() -> None:
        mic = micmod.MicAudioSource()
        await mic.start()
        mic.set_level_source(
            _FakeTrack([_other_entry(), _stats_entry("video", 0.0), _stats_entry("audio", 0.31)])
        )
        assert await mic.read_level() == pytest.approx(0.31)
        await mic.stop()

    asyncio.run(scenario())


def test_empty_stats_collection_holds_the_last_level() -> None:
    # A collection can come back with no entries at all. Reporting 0.0 for one
    # would make the meter flicker to silence mid-speech.
    async def scenario() -> None:
        mic = micmod.MicAudioSource()
        await mic.start()
        mic.set_level_source(_FakeTrack([_stats_entry("audio", 0.5)], []))
        assert await mic.read_level() == pytest.approx(0.5)
        assert await mic.read_level() == pytest.approx(0.5)
        await mic.stop()

    asyncio.run(scenario())


def test_level_read_failure_is_logged_once_and_holds() -> None:
    class _Failing:
        async def get_stats(self) -> Any:
            raise RuntimeError("stats unavailable")

    async def scenario() -> None:
        mic = micmod.MicAudioSource()
        await mic.start()
        mic.set_level_source(_Failing())
        assert await mic.read_level() == 0.0
        assert await mic.read_level() == 0.0
        assert mic._level_unavailable_logged is True
        await mic.stop()

    asyncio.run(scenario())


def test_level_without_a_track_is_zero() -> None:
    async def scenario() -> None:
        mic = micmod.MicAudioSource()
        await mic.start()
        assert await mic.read_level() == 0.0
        await mic.stop()

    asyncio.run(scenario())


def test_stop_clears_the_level_source() -> None:
    # A stale track outliving the mic would keep reporting a level for a
    # microphone that is no longer publishing.
    async def scenario() -> None:
        mic = micmod.MicAudioSource()
        await mic.start()
        mic.set_level_source(_FakeTrack([_stats_entry("audio", 0.7)]))
        assert await mic.read_level() == pytest.approx(0.7)
        await mic.stop()
        assert mic.level == 0.0
        assert await mic.read_level() == 0.0

    asyncio.run(scenario())
