"""Default-microphone capture backing :meth:`RealtimeSession.set_microphone_enabled`.

Capture runs inside WebRTC's Audio Device Module via ``rtc.PlatformAudio``:
the ADM owns the device, applies echo cancellation / noise suppression / gain
control, and feeds the track directly.

No PCM crosses into Python — the ADM sends frames straight to WebRTC — so the
level cannot be measured here. WebRTC computes it anyway for its own purposes
and reports it as a track statistic, which is what ``read_level`` samples.

For non-mic sources (synthetic, WAV replay, load generators) use
:meth:`RealtimeSession.start_audio_stream` directly.
"""

from __future__ import annotations

from typing import Any, Optional

import structlog
from livekit import rtc

from cosmo_ai._internal.logging import get_logger
from cosmo_ai.audio import MicrophoneCapture
from cosmo_ai.errors import AudioUnavailableError

logger: structlog.stdlib.BoundLogger = get_logger(__name__)


def _audio_level(stats: Any) -> Optional[float]:
    """The capture level WebRTC reports for the local audio source, or ``None``
    when this collection carries no audio source — a session publishing video
    reports several media sources, and an empty collection is normal."""
    for entry in stats:
        if entry.WhichOneof("stats") != "media_source":
            continue
        media_source = entry.media_source
        if media_source.source.kind != "audio":
            continue
        return float(media_source.audio.audio_level)
    return None


def _to_platform_options(capture: MicrophoneCapture) -> Any:
    return rtc.PlatformAudioOptions(
        echo_cancellation=capture.echo_cancellation,
        noise_suppression=capture.noise_suppression,
        auto_gain_control=capture.auto_gain_control,
    )


class MicAudioSource:
    """Streams the default input device into one LiveKit audio source.

    Not thread-safe across asyncio loops: create, start, and stop from the same
    loop."""

    def __init__(self, capture: Optional[MicrophoneCapture] = None) -> None:
        self._capture = capture or MicrophoneCapture()
        self._platform: Any = None
        self._source: Any = None
        self._track: Any = None
        self._level_unavailable_logged = False
        self.level: float = 0.0

    @property
    def livekit_source(self) -> Any:
        """The ADM-backed source to hand to ``publish_audio_source``. Available
        only between ``start`` and ``stop``."""
        if self._source is None:
            raise RuntimeError("MicAudioSource.start() must run before publishing")
        return self._source

    async def start(self) -> None:
        """Open the Audio Device Module and begin capturing.

        Raises ``AudioUnavailableError`` when no input device is usable — a
        headless host, a denied permission, a device already held exclusively."""
        if self._source is not None:
            return
        platform: Any = None
        try:
            platform = rtc.PlatformAudio()
            source = platform.create_audio_source(_to_platform_options(self._capture))
        except Exception as exc:
            self._close_platform(platform)
            raise AudioUnavailableError(
                f"could not open an input device for capture: {exc}"
            ) from exc
        self._platform = platform
        self._source = source

    def set_level_source(self, track: Any) -> None:
        """Name the published track :meth:`read_level` samples."""
        self._track = track

    async def read_level(self) -> float:
        """Sample the capture level, for :meth:`RealtimeSession.audio_levels`.

        Sampled on demand rather than metered continuously: reading it costs a
        stats collection, which a session that never asks for levels should not
        pay. A collection that carries no audio source holds the last value
        instead of reporting silence."""
        track = self._track
        if track is None:
            return 0.0
        try:
            level = _audio_level(await track.get_stats())
        except Exception:
            if not self._level_unavailable_logged:
                self._level_unavailable_logged = True
                logger.exception("realtime.mic_level_read_failed", stack_info=True)
            return self.level
        if level is not None:
            self.level = level
        return self.level

    async def stop(self) -> None:
        """Stop capture and release the device promptly.

        The ADM holds a native device handle that a garbage-collected release
        would free at an unpredictable time, which on Windows blocks the next
        capture; both handles are closed explicitly instead."""
        self._track = None
        self.level = 0.0
        source, self._source = self._source, None
        if source is not None:
            try:
                source.close()
            except Exception:
                logger.exception("realtime.mic_source_close_failed", stack_info=True)
        platform, self._platform = self._platform, None
        self._close_platform(platform)

    def _close_platform(self, platform: Any) -> None:
        if platform is None:
            return
        try:
            platform.close()
        except Exception:
            logger.exception("realtime.mic_platform_close_failed", stack_info=True)
