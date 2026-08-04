# cosmo-realtime-page

Minimal Vite + React 19 app that demonstrates `cosmo-ai` — the published
TypeScript SDK for Cosmo voice sessions.

## What it shows

- `CosmoRealtimeProvider` wrapping a manually constructed `RealtimeClient`
- `RealtimeAudio` for automatic audio output binding
- `MicToggle` for push-to-talk / mute control
- `useTranscript()` rendering a live turn-by-turn transcript stream
- `useToolCalls()` showing in-flight and completed tool invocations
- `useTransportState()` surfacing the connection state label

## Quick start

```bash
cd examples/realtime-page
npm install
npm run dev
```

Open http://localhost:5173, enter your API key, then select
**Start Session**. Allow microphone access when the browser asks.

The `cosmo-ai` dependency is `file:../..` — this example lives inside
the SDK package at `examples/realtime-page/`, so two levels up is the SDK
root. Build the SDK first (`npm run build` in the SDK root) so `dist/`
exists; CI does the same.

## Environment

The following table describes the fields the page asks for.

| Field | Description |
|---|---|
| API Key | `cosmo_…` bearer token from the Cosmo dashboard (the server resolves the workspace and project from it) |
| Base URL | Override the default Cosmo API origin (optional) |

## Screenshot (synthetic)

```
┌─────────────────────────────────────────┐
│  Cosmo Realtime Hello World             │
│                                         │
│  [connected] [🎤 Mute] [End Session]    │
│                                         │
│  Transcript                             │
│  ┌─────────────────────────────────┐    │
│  │ ASSISTANT                       │    │
│  │ Hi! How can I help you today?   │    │
│  └─────────────────────────────────┘    │
│       ┌──────────────────────────────┐  │
│       │ USER                         │  │
│       │ What's on my calendar?…      │  │
│       └──────────────────────────────┘  │
│                                         │
│  Tool Calls                             │
│  get_calendar_events [in_flight]        │
└─────────────────────────────────────────┘
```
