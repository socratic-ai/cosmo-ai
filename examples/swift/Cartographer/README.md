# Cartographer

A SwiftUI macOS app that listens while you think out loud and draws what you
say as a live mind map. Ideas land on the canvas while the agent is still
speaking, because each one arrives as a client tool call.

Where `HelloRealtime` shows the session in a terminal, this shows it wired to
a real UI: streaming transcripts folded into a view model, client tools
mutating on-screen state, and a hook enforcing an app-side limit.

## Requirements

- macOS 14+. The SDK itself runs on macOS 13; this app's UI uses SwiftUI's
  `onChange(of:initial:_:)` and `defaultScrollAnchor`, which are macOS 14.
- A credential with the `realtime:use` scope

## Run

```bash
pipx install cosmo-cli && cosmo login
./run.sh              # talk to it
./run.sh --demo       # no mic: connects and types a seed idea for you
```

`run.sh` builds the `.app` bundle via `bundle.sh` on first run, then launches
it. `--demo` is the fastest way to see the pipeline end to end without
granting microphone access.

## What it shows

| SDK surface | Where |
| --- | --- |
| `RealtimeSession.start` + the typed `events` stream | `Conductor.consume(_:)` |
| Client tools with `Decodable` args (`SessionConfig.Tool.define`) | `Conductor.mapTools()` |
| `preToolUse` deny and `sessionEnd` hooks | `Conductor.mapHooks()` |
| Transcript append vs replace | `Conductor.append(_:_:isFinal:)` / `replace(_:_:)` |
| `setMuted`, `send(text:)`, `end()` | `Conductor.toggleMute()` / `say(_:)` / `stop()` |

Two details in `Conductor` are worth reading before you copy this shape into
your own app:

**Transcripts aren't all the same.** A non-final `transcript` event carries
only the new fragment for that turn, so you append it. The final event carries
the whole turn, so you replace what you accumulated. Rendering both the same
way duplicates every turn once it reaches a real UI.

**Don't gate your UI on `ready`.** It's a single broadcast frame, and a
client whose data channel attaches late never sees it. `Conductor` latches the
session live on the first event of any kind instead.

## `bundle.sh`

`swift build` produces a bare executable, which isn't enough to capture audio.
The script assembles a real `.app` because three things are required and none
of them come for free outside Xcode:

1. An `Info.plist` with `NSMicrophoneUsageDescription`. Without a bundle there
   is nowhere for macOS to read the usage string from, so the microphone
   prompt never appears.
2. The macOS slice of LiveKit's binary xcframeworks copied into
   `Contents/Frameworks/`, plus an `@executable_path/../Frameworks` rpath.
   SwiftPM links them but doesn't embed them, so a hand-assembled bundle dies
   at launch on `Library not loaded: @rpath/LiveKitWebRTC.framework/...`.
3. An ad-hoc signature with `com.apple.security.cs.disable-library-validation`.
   Those frameworks carry a different team identity, which the hardened
   runtime otherwise rejects. Embedded frameworks must be signed before the
   bundle that contains them.

Use it as a starting point for packaging your own SwiftPM-built app.

## `Probe`

A headless, text-only target that connects, declares one client tool, sends a
line, proves the tool round-trips, and hangs up. No window and no microphone,
which makes it the quickest way to check a session works.

```bash
COSMO_API_KEY=cosmo_... NO_AUDIO=1 swift run Probe
```

Set `COSMO_BASE_URL` to point it somewhere other than `https://platform.askcosmo.ai`.
It writes to stderr because `print` is block-buffered when stdout is a pipe,
which makes a live session look like a hang.
