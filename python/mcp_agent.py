"""Run a realtime agent whose tools come from a local stdio MCP server.

Prereqs: `pip install 'cosmo-ai-sdk[mcp]'` and Node (for `npx`).
Set COSMO_API_KEY (and COSMO_BASE_URL for a non-prod backend). Then:
`python examples/mcp_agent.py`
"""

import asyncio
import os
from pathlib import Path

from cosmo_ai import CosmoRealtime


async def main() -> None:
    client = CosmoRealtime(api_key=os.environ["COSMO_API_KEY"])
    agent = client.agent(
        instructions="You can use the connected MCP tools to help the user.",
        mcp=Path(__file__).parent / "mcp.json",
    )
    async with agent.start() as session:
        await session.set_microphone_enabled(True)
        async for event in session:
            print(event)


if __name__ == "__main__":
    asyncio.run(main())
