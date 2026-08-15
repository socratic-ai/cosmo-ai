"""MCP servers for the realtime SDK: local (stdio) MCP servers whose tools are
exposed to the model, each call proxied to the live server subprocess.

Attach servers with the ``mcp`` argument on :meth:`RealtimeClient.agent` — a
``.mcp.json`` config file (the Claude Code format), or a list whose elements
are config files and/or inline :class:`McpStdioServer` objects. See
:mod:`cosmo_ai.mcp._engine` for the parse/connect semantics.
"""

from cosmo_ai.mcp._engine import (
    McpConfigError,
    McpExtraNotInstalledError,
    McpInput,
    McpStdioServer,
)

__all__ = ["McpConfigError", "McpExtraNotInstalledError", "McpInput", "McpStdioServer"]
