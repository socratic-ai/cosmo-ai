"""SpeakerSink: gain math, underrun padding, lifecycle — sounddevice stubbed,
no PortAudio needed."""

from __future__ import annotations

import asyncio
from typing import Any, AsyncIterator

import pytest

import cosmo_ai.audio._sounddevice as sdgate
import cosmo_ai.audio._speaker as spkmod
from cosmo_ai.audio import AgentAudioFrame
from cosmo_ai.audio._speaker import SpeakerSink, _apply_gain


class _FakeRawOutputStream:
    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs
        self.callback = kwargs["callback"]
        self.started = False
        self.closed = False

    def start(self) -> None:
        self.started = True

    def stop(self) -> None:
        self.started = False

    def close(self) -> None:
        self.closed = True


class _FakeSounddevice:
    def __init__(self) -> None:
        self.streams: list[_FakeRawOutputStream] = []

    def RawOutputStream(self, **kwargs: Any) -> _FakeRawOutputStream:
        stream = _FakeRawOutputStream(**kwargs)
        self.streams.append(stream)
        return stream


@pytest.fixture()
def fake_sd(monkeypatch: pytest.MonkeyPatch) -> _FakeSounddevice:
    sd = _FakeSounddevice()
    monkeypatch.setattr(sdgate, "ensure_sounddevice", lambda: sd)
    return sd


def _frame(data: bytes) -> AgentAudioFrame:
    return AgentAudioFrame(
        data=data, sample_rate=48000, num_channels=1, samples_per_channel=len(data) // 2
    )


async def _iter_frames(frames: list[AgentAudioFrame]) -> AsyncIterator[AgentAudioFrame]:
    for frame in frames:
        yield frame


def test_apply_gain_scales_clamps_and_short_circuits() -> None:
    pcm = (1000).to_bytes(2, "little", signed=True) * 4
    assert _apply_gain(pcm, 1.0) is pcm
    assert _apply_gain(pcm, 0.0) == b"\x00" * 8
    halved = _apply_gain(pcm, 0.5)
    assert halved == (500).to_bytes(2, "little", signed=True) * 4


def test_fill_buffers_audio_and_callback_drains_with_underrun_padding(
    fake_sd: _FakeSounddevice,
) -> None:
    async def scenario() -> None:
        sink = SpeakerSink()
        pcm = (1000).to_bytes(2, "little", signed=True) * 480
        await sink.start(_iter_frames([_frame(pcm)]))
        stream = fake_sd.streams[0]
        assert stream.started is True
        assert stream.kwargs["samplerate"] == spkmod.AGENT_AUDIO_SAMPLE_RATE
        assert stream.kwargs["channels"] == spkmod.NUM_CHANNELS
        assert stream.kwargs["dtype"] == "int16"
        for _ in range(10):
            await asyncio.sleep(0)
        out = bytearray(2000)
        stream.callback(out, 1000, None, None)
        assert bytes(out[: len(pcm)]) == pcm
        assert bytes(out[len(pcm) :]) == b"\x00" * (2000 - len(pcm))
        # buffer drained: next callback is pure silence
        out2 = bytearray(100)
        stream.callback(out2, 50, None, None)
        assert bytes(out2) == b"\x00" * 100
        await sink.stop()
        assert stream.closed is True

    asyncio.run(scenario())


def test_volume_applied_at_fill_time(fake_sd: _FakeSounddevice) -> None:
    async def scenario() -> None:
        sink = SpeakerSink(volume=0.5)
        pcm = (1000).to_bytes(2, "little", signed=True) * 480
        await sink.start(_iter_frames([_frame(pcm)]))
        for _ in range(10):
            await asyncio.sleep(0)
        out = bytearray(960)
        fake_sd.streams[0].callback(out, 480, None, None)
        assert bytes(out) == (500).to_bytes(2, "little", signed=True) * 480
        await sink.stop()

    asyncio.run(scenario())


def test_set_volume_clamps() -> None:
    sink = SpeakerSink()
    sink.set_volume(3.5)
    assert sink._volume == 1.0
    sink.set_volume(-1.0)
    assert sink._volume == 0.0


def test_start_is_idempotent_and_broken_sounddevice_raises(
    monkeypatch: pytest.MonkeyPatch, fake_sd: _FakeSounddevice
) -> None:
    async def scenario() -> None:
        sink = SpeakerSink()
        await sink.start(_iter_frames([]))
        await sink.start(_iter_frames([]))
        assert len(fake_sd.streams) == 1
        await sink.stop()

        def _boom() -> Any:
            raise OSError("PortAudio library not found")

        monkeypatch.setattr(sdgate, "ensure_sounddevice", _boom)
        with pytest.raises(OSError):
            await SpeakerSink().start(_iter_frames([]))

    asyncio.run(scenario())


def test_buffer_is_capped_dropping_oldest(fake_sd: _FakeSounddevice) -> None:
    async def scenario() -> None:
        sink = SpeakerSink()
        big = b"\x01\x01" * (spkmod._MAX_BUFFERED_BYTES // 2)
        await sink.start(_iter_frames([_frame(big), _frame(b"\x02\x02" * 480)]))
        for _ in range(10):
            await asyncio.sleep(0)
        assert len(sink._buffer) == spkmod._MAX_BUFFERED_BYTES
        assert bytes(sink._buffer[-4:]) == b"\x02\x02\x02\x02"
        await sink.stop()

    asyncio.run(scenario())


def test_fill_failure_logs_and_releases_stream(fake_sd: _FakeSounddevice) -> None:
    async def scenario() -> None:
        async def exploding_frames() -> AsyncIterator[AgentAudioFrame]:
            raise RuntimeError("iterator failed")
            yield  # unreachable; makes this an async generator

        sink = SpeakerSink()
        await sink.start(exploding_frames())
        for _ in range(10):
            await asyncio.sleep(0)
        assert fake_sd.streams[0].closed is True
        assert sink._stream is None
        await sink.stop()  # idempotent after self-release

    asyncio.run(scenario())


def test_start_failure_closes_the_opened_stream(fake_sd: _FakeSounddevice) -> None:
    async def scenario() -> None:
        sink = SpeakerSink()

        def _boom_start() -> None:
            raise RuntimeError("device unavailable")

        original = fake_sd.RawOutputStream

        def raw_output_stream(**kwargs: Any) -> _FakeRawOutputStream:
            stream = original(**kwargs)
            stream.start = _boom_start  # type: ignore[method-assign]
            return stream

        fake_sd.RawOutputStream = raw_output_stream  # type: ignore[method-assign]
        with pytest.raises(RuntimeError):
            await sink.start(_iter_frames([]))
        assert fake_sd.streams[0].closed is True
        assert sink._stream is None
        assert sink._fill_task is None

    asyncio.run(scenario())
