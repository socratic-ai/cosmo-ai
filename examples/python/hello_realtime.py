"""Text-only demo of the event-stream SDK surface.

No microphone or speaker required — this example uses the text channel only.
The agent still speaks into the room; nothing here plays it. Configure the
agent with audio=AudioConfig(output=False) for a genuinely silent session.

Usage:
    pip install cosmo-ai-sdk cosmo-cli
    python examples/python/hello_realtime.py   # after `cosmo login`, or with COSMO_API_KEY set

The SDK targets https://platform.askcosmo.ai by default; set COSMO_BASE_URL to point
at another backend for local development.
"""

import asyncio
from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel, Field

from cosmo_ai import (
    RealtimeClient,
    ErrorEvent,
    ReadyEvent,
    SessionEndedEvent,
    ToolCallEvent,
    ToolResultEvent,
    TranscriptDeltaEvent,
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
    async with RealtimeClient() as client:
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
                if isinstance(event, ReadyEvent):
                    print(f"[ready] session_id={event.session_id}")
                elif isinstance(event, TranscriptDeltaEvent):
                    marker = "»" if event.is_final else "…"
                    print(f"[transcript:{event.role.value}] {event.text}{marker}")
                elif isinstance(event, ToolCallEvent):
                    print(f"[tool_call] {event.name} (id={event.tool_call_id})")
                elif isinstance(event, ToolResultEvent):
                    status = "ok" if event.ok else "err"
                    print(f"[tool_result:{status}] {event.summary}")
                elif isinstance(event, ErrorEvent):
                    print(f"[error] {event.code.value}: {event.message}")
                elif isinstance(event, UnknownEvent):
                    print(f"[unknown] raw_type={event.raw_type}")
                elif isinstance(event, SessionEndedEvent):
                    print(f"[session-ended] {event.reason}")

            await driver
    print("Session ended.")


if __name__ == "__main__":
    asyncio.run(main())
