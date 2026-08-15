"""Live checks against a real ``livekit-server``.

The rest of the suite stubs livekit, which pins this SDK's wiring but cannot
show that livekit behaves as the wiring assumes. Audio levels are read from a
statistic livekit reports for a published track; whether it reports one for a
given kind of track is a fact only a real server can settle, and a level read
from a track that reports none is silence no stubbed test can distinguish.

Skipped unless ``LIVEKIT_TESTING_URL`` / ``LIVEKIT_TESTING_API_KEY`` /
``LIVEKIT_TESTING_API_SECRET`` are set — point them at any ``livekit-server``
running in dev mode::

    LIVEKIT_TESTING_URL=ws://localhost:7880 \
      LIVEKIT_TESTING_API_KEY=devkey \
      LIVEKIT_TESTING_API_SECRET=devsecretdevsecretdevsecretdevse \
      pytest tests/test_live_audio_levels.py

The microphone case additionally needs ``COSMO_TESTING_MICROPHONE=1``: it opens
the real input device, so it is opt-in rather than part of a default run.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import os
import time

import pytest
from livekit import rtc

from cosmo_ai.audio import MicrophoneCapture
from cosmo_ai.audio._mic import MicAudioSource, _audio_level

URL = os.environ.get("LIVEKIT_TESTING_URL")
KEY = os.environ.get("LIVEKIT_TESTING_API_KEY")
SECRET = os.environ.get("LIVEKIT_TESTING_API_SECRET")

live = pytest.mark.skipif(
    not (URL and KEY and SECRET),
    reason="set LIVEKIT_TESTING_URL / _API_KEY / _API_SECRET for live tests",
)
needs_microphone = pytest.mark.skipif(
    os.environ.get("COSMO_TESTING_MICROPHONE") != "1",
    reason="set COSMO_TESTING_MICROPHONE=1 to open the real input device",
)

SAMPLE_RATE = 48000
FRAME_SAMPLES = SAMPLE_RATE * 20 // 1000

MIC_SAMPLES = 40


def _token(identity: str, room: str) -> str:
    def b64(raw: bytes) -> str:
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

    now = int(time.time())
    header = b64(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    payload = b64(
        json.dumps(
            {
                "exp": now + 600,
                "iss": KEY,
                "nbf": now - 10,
                "sub": identity,
                "name": identity,
                "video": {
                    "room": room,
                    "roomJoin": True,
                    "canPublish": True,
                    "canSubscribe": True,
                },
            },
            separators=(",", ":"),
        ).encode()
    )
    signing_input = f"{header}.{payload}".encode()
    assert SECRET is not None
    return f"{header}.{payload}.{b64(hmac.new(SECRET.encode(), signing_input, hashlib.sha256).digest())}"


async def _joined_room(name: str) -> rtc.Room:
    room = rtc.Room()
    assert URL is not None
    await room.connect(URL, _token(name, name))
    return room


@live
def test_audio_level_is_reported_for_a_published_local_track() -> None:
    """The stats shape ``_audio_level`` reads is what livekit actually returns.

    Uses a synthetic source so it runs where there is no input device — it pins
    the stats contract (a ``media_source`` entry, ``kind == "audio"``, an
    ``audio_level`` field), not the capture path."""

    async def scenario() -> None:
        room = await _joined_room("levels-synthetic")
        try:
            source = rtc.AudioSource(sample_rate=SAMPLE_RATE, num_channels=1)
            track = rtc.LocalAudioTrack.create_audio_track("mic", source)
            publication = await room.local_participant.publish_track(track)

            half_scale = (16384).to_bytes(2, "little", signed=True) * FRAME_SAMPLES
            for _ in range(25):
                await source.capture_frame(
                    rtc.AudioFrame(
                        data=half_scale,
                        sample_rate=SAMPLE_RATE,
                        num_channels=1,
                        samples_per_channel=FRAME_SAMPLES,
                    )
                )

            local = publication.track
            assert local is not None
            level = None
            for _ in range(20):
                await asyncio.sleep(0.25)
                level = _audio_level(await local.get_stats())
                if level:
                    break
            assert level is not None, "livekit reported no audio media source"
            assert level > 0.0, "a track fed half-scale audio reported silence"
        finally:
            await room.disconnect()

    asyncio.run(scenario())


@live
@needs_microphone
def test_microphone_level_is_readable_from_the_device_module() -> None:
    """Capture runs in WebRTC's audio device module, which hands Python no
    frames, so the level has to come from the track statistics.

    Asserts the level moves rather than clearing a fixed threshold: a quiet room
    still reports a small non-zero level, and how loud one is varies by room and
    by microphone, so any absolute bar encodes the machine it was written on. A
    level that changes sample to sample is following the room; a constant one is
    either a track reporting nothing or a value stuck in the cache."""

    async def scenario() -> None:
        room = await _joined_room("levels-microphone")
        mic = MicAudioSource(
            MicrophoneCapture(
                echo_cancellation=False, noise_suppression=False, auto_gain_control=False
            )
        )
        try:
            await mic.start()
            track = rtc.LocalAudioTrack.create_audio_track("mic", mic.livekit_source)
            publication = await room.local_participant.publish_track(track)
            mic.set_level_source(publication.track)

            levels = []
            for _ in range(MIC_SAMPLES):
                await asyncio.sleep(0.25)
                levels.append(await mic.read_level())

            assert any(levels), (
                "every sample was 0.0 — livekit is reporting no level statistic "
                "for a device-module track, so the microphone meter has nothing "
                "to read"
            )
            assert len(set(levels)) > 1, (
                f"the level never changed across {MIC_SAMPLES} samples "
                f"(constant {levels[0]}) — it is not following the microphone"
            )
        finally:
            await mic.stop()
            await room.disconnect()

    asyncio.run(scenario())
