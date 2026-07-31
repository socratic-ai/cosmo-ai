"""Start a realtime agent whose skills load just-in-time from local SKILL.md
files. Run: python examples/skills_agent.py (needs COSMO_API_KEY)."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

from cosmo_ai import CosmoRealtime


async def main() -> None:
    client = CosmoRealtime(api_key=os.environ["COSMO_API_KEY"])
    agent = client.agent(
        instructions="You are Alex at Acme.",
        skills=Path(__file__).parent / "skills",
    )
    async with agent.start() as session:
        async for event in session:
            print(event)


if __name__ == "__main__":
    asyncio.run(main())
