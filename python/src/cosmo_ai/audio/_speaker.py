"""OS-speaker playback backing :meth:`RealtimeSession.set_speaker_enabled`.

``_mic`` inverted: a fill task drains an agent-audio iterator into a
thread-shared buffer (applying the software gain), and PortAudio's callback
thread consumes it, padding underruns with silence. Deliberately built on
the SDK's own decoded-frame fan-out rather than livekit's
``rtc.MediaDevices`` output player: that helper would decode the track a
second time, bypass :meth:`RealtimeSession.agent_audio`, and require a far
newer livekit floor. For custom playback consume
:meth:`RealtimeSession.agent_audio` directly.

The transport decodes agent audio at a fixed 48 kHz mono
(:data:`cosmo_ai.audio.AGENT_AUDIO_SAMPLE_RATE`); the output stream
opens at the same geometry.
"""

from __future__ import annotations

import asyncio
import threading
from array import array
from typing import Any, AsyncIterator, Optional

import structlog

from cosmo_ai._internal.logging import get_logger
from cosmo_ai.audio import AGENT_AUDIO_SAMPLE_RATE, AgentAudioFrame, _sounddevice

logger: structlog.stdlib.BoundLogger = get_logger(__name__)

NUM_CHANNELS = 1
INT16_BYTES = 2
# Cap the thread-shared buffer at ~1 s: a stalled device drops the oldest
# audio instead of growing playback latency without bound.
_MAX_BUFFERED_BYTES = AGENT_AUDIO_SAMPLE_RATE * NUM_CHANNELS * INT16_BYTES


def _apply_gain(data: bytes, volume: float) -> bytes:
    if volume >= 1.0:
        return data
    if volume <= 0.0:
        return b"\x00" * len(data)
    samples = array("h", data)
    for i in range(len(samples)):
        samples[i] = int(samples[i] * volume)
    return samples.tobytes()


class SpeakerSink:
    """Plays one agent-audio iterator on the default output device.

    Create, start, and stop from the same asyncio loop; the PortAudio
    callback runs on its own thread and shares only ``_buffer`` under
    ``_lock``."""

    def __init__(self, *, volume: float = 1.0) -> None:
        self._volume = min(max(volume, 0.0), 1.0)
        self._buffer = bytearray()
        self._lock = threading.Lock()
        self._stream: Optional[Any] = None
        self._fill_task: Optional[asyncio.Task[None]] = None
        self._frames: Optional[AsyncIterator[AgentAudioFrame]] = None

    def set_volume(self, volume: float) -> None:
        self._volume = min(max(volume, 0.0), 1.0)

    async def start(self, frames: AsyncIterator[AgentAudioFrame]) -> None:
        """Open the output device and start draining ``frames`` into it."""
        if self._stream is not None:
            return
        sd = _sounddevice.ensure_sounddevice()
        self._frames = frames
        stream = sd.RawOutputStream(
            samplerate=AGENT_AUDIO_SAMPLE_RATE,
            channels=NUM_CHANNELS,
            dtype="int16",
            callback=self._on_need_audio,
        )
        try:
            stream.start()
        except Exception:
            stream.close()
            self._frames = None
            raise
        self._stream = stream
        self._fill_task = asyncio.create_task(
            self._fill(frames), name="cosmo-realtime-speaker"
        )

    async def stop(self) -> None:
        """Stop playback, close the device, and close the frame iterator."""
        if self._fill_task is not None:
            self._fill_task.cancel()
            try:
                await self._fill_task
            except asyncio.CancelledError:
                pass
            self._fill_task = None
        if self._stream is not None:
            self._stream.stop()
            self._stream.close()
            self._stream = None
        frames, self._frames = self._frames, None
        if frames is not None:
            aclose = getattr(frames, "aclose", None)
            if aclose is not None:
                await aclose()

    async def _fill(self, frames: AsyncIterator[AgentAudioFrame]) -> None:
        try:
            async for frame in frames:
                chunk = _apply_gain(frame.data, self._volume)
                with self._lock:
                    self._buffer.extend(chunk)
                    overflow = len(self._buffer) - _MAX_BUFFERED_BYTES
                    if overflow > 0:
                        del self._buffer[:overflow]
        except asyncio.CancelledError:
            raise
        except Exception:
            # A dead fill task must not leave the device playing silence with
            # no trace: log and release the output stream.
            logger.exception("realtime.speaker_fill_failed", stack_info=True)
            stream, self._stream = self._stream, None
            if stream is not None:
                stream.stop()
                stream.close()

    def _on_need_audio(
        self, outdata: Any, frames: int, time_info: object, status: Any
    ) -> None:
        """PortAudio callback (its own thread): drain buffered PCM, pad the
        shortfall with silence."""
        needed = frames * NUM_CHANNELS * INT16_BYTES
        with self._lock:
            take = bytes(self._buffer[:needed])
            del self._buffer[:needed]
        outdata[: len(take)] = take
        if len(take) < needed:
            outdata[len(take) :] = b"\x00" * (needed - len(take))
