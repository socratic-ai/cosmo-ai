"""Drive a skills-enabled agent with a TEXT turn and watch cosmo_sdk_load_skill fire.

A no-microphone way to see skills end-to-end: it sends one text message (text
in, text out — no audio playback needed) and prints the event stream, calling
out the moment the model invokes `cosmo_sdk_load_skill` and the private
instructions are handed back.

Run (needs a backend + key):

    pip install cosmo-ai-sdk
    COSMO_API_KEY=cosmo_... python examples/python/skills_text_test.py
    # optional: a different prompt, and a different backend
    COSMO_API_KEY=cosmo_... COSMO_BASE_URL=http://localhost:8000 \\
        python examples/python/skills_text_test.py "my card was stolen"

What to look for in the output:
    [tool-invocation] cosmo_sdk_load_skill {"name": "activate-card"}   <- the model picked a skill
    [assistant] ...follows the skill's private instructions...
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

from cosmo_ai import (
    RealtimeClient,
    ErrorEvent,
    ModelTextEvent,
    ReadyEvent,
    SessionEndedEvent,
    ToolInvocationEvent,
    TranscriptDeltaEvent,
    TranscriptRole,
    TurnCompleteEvent,
)

INSTRUCTIONS = (
    "You are Alex, a customer support agent at Acme. "
    "Keep replies short and spoken. When the conversation reaches a path one of "
    "your skills covers, call cosmo_sdk_load_skill first, then follow its instructions."
)
DEFAULT_PROMPT = "Hey, how do I activate my new card?"


async def run(prompt: str) -> None:
    base_url = os.environ.get("COSMO_BASE_URL", "https://platform.askcosmo.ai")

    skills_dir = Path(__file__).parent / "skills"
    print("Skills directories found (local, from examples/python/skills/):")
    for skill_md in sorted(skills_dir.glob("*/SKILL.md")):
        print(f"  - {skill_md.parent.name}")
    print(f"\nPrompt: {prompt!r}\nConnecting to {base_url} ...\n")

    client = RealtimeClient()
    agent = client.agent(instructions=INSTRUCTIONS, skills=skills_dir)
    async with agent.start() as session:
        await session.send_text(prompt)
        async for event in session:
            if isinstance(event, ReadyEvent):
                print(f"[ready] session_id={event.session_id}")
            elif isinstance(event, ToolInvocationEvent):
                print(f"[tool-invocation] {event.name} {event.args}   <- skill picked")
            elif isinstance(event, ModelTextEvent) and event.text:
                print(f"[assistant-text] {event.text}", end="", flush=True)
            elif isinstance(event, TranscriptDeltaEvent) and event.is_final:
                who = "user" if event.role == TranscriptRole.USER else "assistant"
                print(f"[{who}] {event.text}")
            elif isinstance(event, ErrorEvent):
                print(f"[error] {event.code}: {event.message} (fatal={event.fatal})")
                if event.fatal:
                    break
            elif isinstance(event, TurnCompleteEvent):
                if event.role == TranscriptRole.ASSISTANT:
                    print("\n[turn complete] ending.")
                    break
            elif isinstance(event, SessionEndedEvent):
                break


if __name__ == "__main__":
    prompt = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_PROMPT
    try:
        asyncio.run(asyncio.wait_for(run(prompt), timeout=90))
    except asyncio.TimeoutError:
        print("\n[timeout] no assistant turn completed within 90s.")
