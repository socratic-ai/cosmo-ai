"""Drive a skills-enabled agent with a TEXT turn and watch load_skill fire.

A no-microphone way to see skills end-to-end: it sends one text message (text
in, text out — no audio playback needed) and prints the event stream, calling
out the moment the model invokes `load_skill` and the private instructions are
handed back.

Run (needs a backend + key):

    cd sdks/cosmo-realtime/python
    COSMO_API_KEY=cosmo_... ./.venv/bin/python examples/skills_text_test.py
    # optional: a different prompt, and a different backend
    COSMO_API_KEY=cosmo_... COSMO_BASE_URL=http://localhost:8000 \\
        ./.venv/bin/python examples/skills_text_test.py "my card was stolen"

What to look for in the output:
    [tool-invocation] load_skill {"name": "activate-card"}   <- the model picked a skill
    [assistant] ...follows the skill's private instructions...
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

from cosmo_ai import (
    CosmoRealtime,
    RealtimeError,
    RealtimeModelText,
    RealtimeReady,
    RealtimeSessionEnded,
    RealtimeToolInvocation,
    RealtimeTranscriptDelta,
    RealtimeTranscriptRole,
    RealtimeTurnComplete,
)

INSTRUCTIONS = (
    "You are Alex, a customer support agent at Acme. "
    "Keep replies short and spoken. When the conversation reaches a path one of "
    "your skills covers, call load_skill first, then follow its instructions."
)
DEFAULT_PROMPT = "Hey, how do I activate my new card?"


async def run(prompt: str) -> None:
    api_key = os.environ.get("COSMO_API_KEY")
    if not api_key:
        sys.exit("Set COSMO_API_KEY (a workspace api key) to run this test.")
    base_url = os.environ.get("COSMO_BASE_URL", "https://app.askcosmo.ai")

    skills_dir = Path(__file__).parent / "skills"
    print("Skills directories found (local, from examples/skills/):")
    for skill_md in sorted(skills_dir.glob("*/SKILL.md")):
        print(f"  - {skill_md.parent.name}")
    print(f"\nPrompt: {prompt!r}\nConnecting to {base_url} ...\n")

    client = CosmoRealtime(api_key=api_key)
    agent = client.agent(instructions=INSTRUCTIONS, skills=skills_dir)
    async with agent.start() as session:
        await session.send_text(prompt, audio_response=False)
        async for event in session:
            if isinstance(event, RealtimeReady):
                print(f"[ready] session_id={event.session_id}")
            elif isinstance(event, RealtimeToolInvocation):
                print(f"[tool-invocation] {event.name} {event.args}   <- skill picked")
            elif isinstance(event, RealtimeModelText) and event.text:
                print(f"[assistant-text] {event.text}", end="", flush=True)
            elif isinstance(event, RealtimeTranscriptDelta) and event.is_final:
                who = "user" if event.role == RealtimeTranscriptRole.USER else "assistant"
                print(f"[{who}] {event.text}")
            elif isinstance(event, RealtimeError):
                print(f"[error] {event.code}: {event.message} (fatal={event.fatal})")
                if event.fatal:
                    break
            elif isinstance(event, RealtimeTurnComplete):
                if event.role == RealtimeTranscriptRole.ASSISTANT:
                    print("\n[turn complete] ending.")
                    break
            elif isinstance(event, RealtimeSessionEnded):
                break


if __name__ == "__main__":
    prompt = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_PROMPT
    try:
        asyncio.run(asyncio.wait_for(run(prompt), timeout=90))
    except asyncio.TimeoutError:
        print("\n[timeout] no assistant turn completed within 90s.")
