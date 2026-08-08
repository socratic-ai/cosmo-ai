# Python (`cosmo-ai-sdk` on PyPI, import `cosmo_ai`)

Read [core.md](core.md) first. Full API reference:
https://platform.askcosmo.ai/docs. This file is the Python gotchas.

## Current shape

```python
import asyncio
from cosmo_ai import CosmoRealtime, RealtimeSessionEnded, RealtimeTranscriptDelta

async def main() -> None:
    # Zero-argument: resolves COSMO_API_KEY, else the `cosmo login`
    # credentials file. Pass api_key=... / token=... to override.
    async with CosmoRealtime() as client:
        agent = client.agent(instructions="You are a terse assistant.", voice="Upbeat")
        async with agent.start() as session:
            await session.set_microphone_enabled(True)
            await session.set_speaker_enabled(True)
            async for event in session:
                match event:
                    case RealtimeTranscriptDelta():
                        print(event.text)
                    case RealtimeSessionEnded():
                        print("ended:", event.reason)

asyncio.run(main())
```

## Gotchas

- **Package vs import**: install `cosmo-ai-sdk`, import `cosmo_ai`.
- **`agent.start()` is both awaitable and an async context manager** —
  `async with` ends the session on exit.
- **Tools**: the `@tool` decorator's first parameter is a Pydantic model;
  it drives the model-facing JSON Schema, validation, and the typed
  handler argument. Never hand-write a schema. The docstring becomes the
  tool description.
- **Slow tools**: `@tool(background=True)`. The handler takes exactly two
  parameters, `(input, job: ClientToolJob)`, and returns `None` — `await
  job.ack(note="on it")` releases the reply so the agent keeps talking,
  then `await job.complete(result=..., summary=...)` or `await
  job.fail(error=...)` delivers the outcome whenever the work lands. The
  arity is checked at decoration time, so a one-parameter background
  handler fails immediately.
- **Alpine images fail**: `livekit` publishes no musl wheel — use a
  `python:*-slim` base. On Linux, speaker playback needs PortAudio
  (`apt install libportaudio2`); microphone capture runs in WebRTC's
  audio device module and needs no extra library.
- The only install extra is `[mcp]` (attaching MCP servers).

## Build it end to end

The voice-agent-with-a-tool walkthrough:
[../examples/build-a-voice-agent.md](../examples/build-a-voice-agent.md).
