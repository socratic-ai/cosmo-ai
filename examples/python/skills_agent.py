"""Start a realtime agent whose skills load just-in-time from local SKILL.md
files. Run: python examples/python/skills_agent.py (after `pipx install cosmo-cli
&& cosmo login`, or with COSMO_API_KEY set)."""

from __future__ import annotations

import asyncio
from pathlib import Path

from cosmo_ai import RealtimeClient


async def main() -> None:
    client = RealtimeClient()
    agent = client.agent(
        instructions="You are Alex at Acme.",
        skills=Path(__file__).parent / "skills",
    )
    async with agent.start() as session:
        async for event in session:
            print(event)


if __name__ == "__main__":
    asyncio.run(main())
