"""Headless proof that MCP tools connect and are callable — no audio.

Connects the local MCP server, prints the exposed tool names and any skips,
and invokes one tool's proxy handler directly to show the round-trip. Drives
the SDK's internal connect machinery — an app never calls this; it passes
``mcp=`` to ``client.agent(...)`` and the session does the rest.

Run: `pip install 'cosmo-ai-sdk[mcp]'` then `python examples/mcp_text_test.py`
"""

import asyncio
from pathlib import Path

from cosmo_ai.mcp._engine import connect_mcp, resolve_mcp


async def main() -> None:
    servers = resolve_mcp(Path(__file__).parent / "mcp.json")
    assert servers is not None
    connected = await connect_mcp(servers)
    try:
        print("Exposed MCP tools:")
        for tool in connected.tools:
            print(f"  - {tool.name}: {tool.description[:60]}")
        if connected.skipped:
            print("Skipped:")
            for s in connected.skipped:
                print(f"  - {s.server}/{s.tool}: {s.reason}")
        # Invoke the first tool's proxy handler with empty args as a smoke test.
        if connected.tools and connected.tools[0].handler is not None:
            name = connected.tools[0].name
            print(f"\nCalling {name}(...)")
            result = await connected.tools[0].handler({})
            print("Result:", result)
    finally:
        await connected.aclose()


if __name__ == "__main__":
    asyncio.run(main())
