"""The sounddevice import seam turns a missing or unloadable PortAudio into a
typed, actionable :class:`AudioUnavailableError` — not a bare ``OSError`` — so
the most common first-run audio failure names its own fix."""

from __future__ import annotations

import builtins
from typing import Any

import pytest
from cosmo_ai import AudioUnavailableError, RealtimeError
from cosmo_ai.audio._sounddevice import ensure_sounddevice


@pytest.mark.parametrize(
    "raised",
    [
        OSError("PortAudio library not found"),
        ImportError("No module named 'sounddevice'"),
    ],
)
def test_unloadable_portaudio_raises_actionable_error(
    monkeypatch: pytest.MonkeyPatch, raised: Exception
) -> None:
    real_import = builtins.__import__

    def fake_import(name: str, *args: Any, **kwargs: Any) -> Any:
        if name == "sounddevice":
            raise raised
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)

    with pytest.raises(AudioUnavailableError) as exc_info:
        ensure_sounddevice()

    err = exc_info.value
    assert isinstance(err, RealtimeError)
    message = str(err)
    assert "PortAudio" in message
    # Names the platform that actually has to act, without prescribing one
    # distribution's package name.
    assert "Linux" in message
    assert err.__cause__ is raised
