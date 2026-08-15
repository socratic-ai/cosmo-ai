"""Audio: the public payload types, backed by the SDK's audio plumbing.

The types here are needed only when you take audio somewhere yourself. A
small voice app never imports them: ``set_speaker_enabled(True)`` plays the
agent out loud and ``audio_levels()`` yields ready-made samples. Import from
here when you consume :meth:`RealtimeSession.agent_audio` (recording, piping,
a custom player) or annotate handlers for either iterator.

The machinery is this package's private plumbing: OS-mic capture (``_mic``),
OS-speaker playback (``_speaker``), the agent-audio fan-out (``_broadcast``),
and the sounddevice import gate (``_sounddevice``).
"""

from __future__ import annotations

from dataclasses import dataclass

AGENT_AUDIO_SAMPLE_RATE = 48000
"""The fixed geometry agent audio is decoded at: 48 kHz, mono, 16-bit."""


@dataclass(frozen=True)
class MicrophoneCapture:
    """Which processors run on captured microphone audio before it is encoded
    and sent, for :meth:`RealtimeSession.set_microphone_enabled`.

    Distinct from :class:`AudioConfig`'s ``noise_cancellation``, which asks the
    *server* to run Cosmo's noise cancellation on the received stream. These
    run client-side, on the raw capture, before anything leaves the machine.

    Echo cancellation is the one to leave on whenever the agent is audible on
    speakers: without it the agent's own voice re-enters the microphone and it
    talks over itself. The other two attenuate the speaker's level, which is
    occasionally the wrong trade — noise suppression and gain control can duck
    a person who talks while the agent is talking, far enough that the agent
    stops registering the interruption.

    These three flags are the processors every Cosmo SDK can express
    identically. Which implementation runs them — the platform's voice
    processing unit or in-process DSP — is not settable here, because the
    SDKs do not agree on how finely that can be chosen.
    """

    echo_cancellation: bool = True
    noise_suppression: bool = True
    auto_gain_control: bool = True


@dataclass(frozen=True)
class AgentAudioFrame:
    """One decoded frame of the agent's voice: 16-bit little-endian PCM,
    ``num_channels`` interleaved."""

    data: bytes
    sample_rate: int
    num_channels: int
    samples_per_channel: int


@dataclass(frozen=True)
class AudioLevels:
    """One metering sample: RMS (0…1) per direction, ``0.0`` while that
    direction is inactive."""

    mic: float
    agent: float
