# Example: build a voice agent with a tool

End-to-end for "build me a voice agent that can look something up". Read
[reference/core.md](../reference/core.md) and
[reference/python.md](../reference/python.md) first — this example
assumes the current API shape.

## 1. Establish which credential the user has

Fastest path — sign in once with the Cosmo CLI; the stored key makes every
SDK work with zero configuration:

```bash
curl -fsSL https://platform.askcosmo.ai/docs/install.sh | sh
cosmo init     # browser sign-in; stores an API key in ~/.cosmo/credentials
```

Alternatively an existing workspace API key with the `realtime:use` scope
(created in the Cosmo web app under **Developer platform → API keys**)
works via `COSMO_API_KEY` or `api_key=...`. Either way, check before
writing code, not after it fails — `client.verify()` reports the key's
scopes and `can_start_sessions` without starting a session or charging
anything.

## 2. Install

```bash
pip install cosmo-ai-sdk
```

## 3. Write it

```python
import asyncio
import sys

from pydantic import BaseModel, Field

from cosmo_ai import (
    RealtimeClient,
    ErrorEvent,
    ReadyEvent,
    RealtimeSession,
    SessionEndedEvent,
    ToolCallEvent,
    TranscriptDeltaEvent,
    TranscriptRole,
    tool,
)

ORDERS = {"A1001": "shipped", "A1002": "processing"}


class OrderInput(BaseModel):
    order_id: str = Field(description="Order id, e.g. A1001")


@tool
async def lookup_order(input: OrderInput) -> dict[str, str]:
    """Current status of a customer order."""
    return {"order_id": input.order_id, "status": ORDERS.get(input.order_id, "not found")}


async def drain(session: RealtimeSession) -> None:
    async for event in session:
        if isinstance(event, ReadyEvent):
            print(f"[ready] {session.session_id} — speak, or press Enter to end.")
            if event.rejected_tools:
                print(f"[warn] rejected tools: {event.rejected_tools}", file=sys.stderr)
        elif isinstance(event, TranscriptDeltaEvent):
            who = "agent" if event.role is TranscriptRole.ASSISTANT else "you"
            print(f"  [{who}] {event.text}{'»' if event.is_final else '…'}")
        elif isinstance(event, ToolCallEvent):
            print(f"  [tool] {event.name}")
        elif isinstance(event, ErrorEvent):
            # Non-fatal errors do not end the session — log and keep iterating.
            level = "fatal" if event.fatal else "error"
            print(f"  [{level}] {event.code.value}: {event.message}", file=sys.stderr)
        elif isinstance(event, SessionEndedEvent):
            print(f"  [ended] {event.reason}")


async def main() -> None:
    # Resolves COSMO_API_KEY, else the `cosmo login` credentials file.
    async with RealtimeClient() as client:
        agent = client.agent(
            instructions="You are a concise order-support agent. Use lookup_order for status questions.",
            voice="Puck",
            tools=[lookup_order],
        )
        async with agent.start() as session:
            printer = asyncio.create_task(drain(session))
            await session.set_microphone_enabled(True)
            await session.set_speaker_enabled(True)

            loop = asyncio.get_running_loop()
            try:
                await loop.run_in_executor(None, sys.stdin.readline)
            except (KeyboardInterrupt, EOFError):
                pass

            await session.end()
            await printer


asyncio.run(main())
```

## 4. Run

```bash
python agent.py                          # after `cosmo login`
# or, skipping the stored login:
COSMO_API_KEY=cosmo_... python agent.py
```

## Things that go wrong

| Symptom | Cause |
|---|---|
| `CredentialsNotFoundError` on construction | no `COSMO_API_KEY` and no stored login — run `cosmo login` (step 1) |
| Session starts, agent never hears you | mic not enabled, or OS mic permission not granted |
| `agent.start()` rejected | key missing the `realtime:use` scope (`verify()` shows `can_start_sessions` false), or a key issued for a different Cosmo backend (`401` — check `COSMO_BASE_URL`) |
| Tool never called | check `ReadyEvent.rejected_tools`; a declared tool with no handler is rejected |

## If they want this in a browser

Do **not** port this file to the front end — it holds an API key. Mint a
per-user JWT server-side instead: the two-sided flow is in the guide's
credential section.
