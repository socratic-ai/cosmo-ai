"""Lazy import seam for ``sounddevice`` — loading it opens PortAudio, so it
stays off the ``import cosmo_ai`` path and out of sessions that never touch
OS audio."""

from __future__ import annotations

from typing import Any

from cosmo_ai.errors import AudioUnavailableError

_PORTAUDIO_HINT = (
    "OS audio is unavailable: the PortAudio system library could not be "
    "loaded. The sounddevice wheel bundles PortAudio on macOS and Windows; "
    "on Linux it comes from the distribution, so install your distro's "
    "PortAudio runtime package and retry."
)


def ensure_sounddevice() -> Any:
    try:
        import sounddevice as sd  # type: ignore  # no stubs
    except (ImportError, OSError) as exc:
        raise AudioUnavailableError(_PORTAUDIO_HINT) from exc

    return sd
