# cosmo-voice-cli

Minimal Python voice CLI that exercises `cosmo-ai-sdk` as a
real two-way voice call. It enables the default OS mic and speaker with one
call each — `session.set_microphone_enabled(True)` /
`session.set_speaker_enabled(True)` — and the agent streams back a transcript
and speaks its replies out loud. (The SDK supplies the OS audio I/O, so there
is no audio code here at all.)

## Quick start

Speaker playback needs the PortAudio native library (bundled in the
[`sounddevice`](https://python-sounddevice.readthedocs.io/) wheels on
macOS/Windows; on Linux install `libportaudio2`, for example, `apt install libportaudio2`).

```bash
cd examples/python/voice_cli
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
Joined room: cosmo-9f2ce46a1b7d43aa9c013d7e
Enabling microphone…
Enabling speaker…
[ready] session_id=3f1c9b2e-8a41-4b6f-9d27-5e0c8a913f64
Speak into your microphone — the agent replies out loud. Press Enter (blank line) to end.
  [user] Hey, can you hear me?…
  [user] Hey, can you hear me?»
  [assistant] Loud and clear — what can I do for you?»
Ending session…
  [ended] client ended
```

Press `Enter` (empty line) or `Ctrl-C` to end the session cleanly.
