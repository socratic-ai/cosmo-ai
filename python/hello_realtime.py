"""Text-only demo of the event-stream SDK surface.

No microphone or speaker required — this example uses the text channel only.
The agent still speaks into the room; nothing here plays it. Configure the
agent with audio=AudioConfig(output=False) for a genuinely silent session.

Usage:
    pip install cosmo-ai-sdk
    COSMO_API_KEY=cosmo_... python examples/hello_realtime.py

The SDK targets https://app.askcosmo.ai by default; set COSMO_BASE_URL to point
at another backend for local development.
"""

import asyncio
import os
from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel, Field

from cosmo_ai import (
    CosmoRealtime,
    RealtimeError,
    RealtimeReady,
    RealtimeSessionEnded,
    RealtimeToolCall,
    RealtimeToolResult,
    RealtimeTranscriptDelta,
    UnknownEvent,
    tool,
)


class TimeInput(BaseModel):
    label: str = Field(default="now", description="Label echoed back with the time")


# The decorated name IS the ClientTool: the input model drives the model-facing
# schema and the validated, typed arguments the handler receives.
@tool
async def get_current_time(input: TimeInput) -> dict[str, Any]:
    """Current UTC time, for questions about the time or date."""
    return {"label": input.label, "utc": datetime.now(timezone.utc).isoformat()}


async def main() -> None:
    api_key = os.environ.get("COSMO_API_KEY")
    if not api_key:
        raise SystemExit("Set COSMO_API_KEY to run this example (e.g. COSMO_API_KEY=cosmo_...).")

    async with CosmoRealtime(api_key=api_key) as client:
        agent = client.agent(
            instructions="You are a terse assistant.",
            tools=[get_current_time],
        )
        async with agent.start() as session:
            print(f"Connected — session_id={session.session_id}")

            async def drive() -> None:
                await asyncio.sleep(2)
                print("Sending text message…")
                await session.send_text(
                    "Hello from the Python SDK! What time is it?"
                )
                await asyncio.sleep(10)
                # Finish the stream; leaving the `async with` would end the
                # session too — this just bounds the demo's runtime.
                await session.end()

            driver = asyncio.create_task(drive())

            async for event in session:
                if isinstance(event, RealtimeReady):
                    print(f"[ready] session_id={event.session_id}")
                elif isinstance(event, RealtimeTranscriptDelta):
                    marker = "»" if event.is_final else "…"
                    print(f"[transcript:{event.role.value}] {event.text}{marker}")
                elif isinstance(event, RealtimeToolCall):
                    print(f"[tool_call] {event.name} (id={event.tool_call_id})")
                elif isinstance(event, RealtimeToolResult):
                    status = "ok" if event.ok else "err"
                    print(f"[tool_result:{status}] {event.summary}")
                elif isinstance(event, RealtimeError):
                    print(f"[error] {event.code.value}: {event.message}")
                elif isinstance(event, UnknownEvent):
                    print(f"[unknown] raw_type={event.raw_type}")
                elif isinstance(event, RealtimeSessionEnded):
                    print(f"[session-ended] {event.reason}")

            await driver
    print("Session ended.")


if __name__ == "__main__":
    asyncio.run(main())
