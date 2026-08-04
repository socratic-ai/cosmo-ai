# cosmo-voice-cli

Minimal Python voice CLI that exercises `cosmo-ai-sdk` as a
real two-way voice call. It enables the default OS mic and speaker with one
call each — `session.set_microphone_enabled(True)` /
`session.set_speaker_enabled(True)` — and the agent streams back a transcript
and speaks its replies out loud. (The SDK's bundled
[`sounddevice`](https://python-sounddevice.readthedocs.io/) supplies the OS
audio I/O, since livekit-rtc Python has none natively.)

## Quick start

`sounddevice` needs the PortAudio native library (bundled in its wheels on
macOS/Windows; on Linux install `libportaudio2`, for example, `apt install libportaudio2`).

```bash
cd examples/voice_cli
pip install -e .

cosmo-voice --api-key cosmo_...
```

Or use environment variables:

```bash
export COSMO_API_KEY=cosmo_...
cosmo-voice
```

## Options

The following table lists the command-line flags and their environment-variable equivalents.

| Flag | Env var | Default |
|---|---|---|
| `--api-key` | `COSMO_API_KEY` | — (required) |
| `--voice` | — | server default |
| `--model` | — | server default |

The SDK targets `https://platform.askcosmo.ai` by default; set the `COSMO_BASE_URL`
environment variable to point at another backend for local development.

## Sample output

```
Connecting…
Joined room: session-abc123
Enabling microphone…
Enabling speaker…
[ready] session_id=sess_xyz
Speak into your microphone — the agent replies out loud. Press Enter (blank line) to end.
  [USER] Hey, what's on my schedule?…
  [USER] Hey, what's on my schedule?»
  [tool] get_calendar_events (id=call_001)
  [ASSISTANT] You have a team standup at 10 AM and a design review at 2 PM.»
Ending session…
  [ended] client ended
```

Press `Enter` (empty line) or `Ctrl-C` to end the session cleanly.
