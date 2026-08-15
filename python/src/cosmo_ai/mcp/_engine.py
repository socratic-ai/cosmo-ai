"""MCP tool source for the realtime SDK: local (stdio) MCP servers whose tools
are exposed to the model as ClientTools, each call proxied to the live MCP
session.

Attach servers with the ``mcp`` argument on :meth:`RealtimeClient.agent` — a
``.mcp.json`` config file (the Claude Code format; one file describes many
servers), or a list whose elements are config files and/or inline
:class:`McpStdioServer` objects (a path element expands, in place, to that
file's servers)::

    agent = client.agent(mcp="./mcp.json")
    agent = client.agent(mcp=[McpStdioServer(name=..., command=..., args=...)])
    agent = client.agent(mcp=[*BUILTIN_SERVERS, "./mcp.json"])

A missing or malformed file and duplicate server names raise
:class:`McpConfigError` when the agent is built, not mid-call. Remote
(``http``/``sse``) entries are skipped with a warning — the file stays
shareable with harnesses that support them; v1 is stdio-only. The ``mcp``
package is imported lazily at connect so importing this module (and
cosmo_ai) never requires the [mcp] extra.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from collections.abc import Sequence
from contextlib import AsyncExitStack
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Union

import structlog

from cosmo_ai._internal.logging import get_logger
from cosmo_ai._internal.schema import (
    sanitize_schema_permissive,
    schema_bound_violation,
)
from cosmo_ai._internal.protocol import (
    _CLIENT_TOOL_MAX_DESCRIPTION_LEN,
    _CLIENT_TOOL_MAX_NAME_LEN,
    _TOOL_SPECS_MAX_COUNT,
    ClientTool,
)
from cosmo_ai.errors import RealtimeError, ExtraNotInstalledError

logger: structlog.stdlib.BoundLogger = get_logger(__name__)


class McpConfigError(RealtimeError, ValueError):
    """The ``mcp`` input is unusable: the config path is not a file, the
    ``.mcp.json`` document is malformed, or two servers share a name."""


@dataclass(frozen=True)
class McpStdioServer:
    """One local MCP server launched over stdio."""

    name: str
    command: str
    args: tuple[str, ...] = ()
    env: dict[str, str] | None = None
    cwd: str | None = None


_REMOTE_TYPES = frozenset({"http", "sse"})


def _parse_mcp_json(data: dict[str, Any]) -> tuple[list[McpStdioServer], list[str]]:
    """Parse a Claude-Code `.mcp.json`. Returns (stdio servers, names of remote
    entries skipped in v1)."""
    raw = data.get("mcpServers")
    if not isinstance(raw, dict):
        raise McpConfigError("`.mcp.json` must contain an object 'mcpServers'")
    servers: list[McpStdioServer] = []
    skipped_remote: list[str] = []
    for name, entry in raw.items():
        if not isinstance(entry, dict):
            raise McpConfigError(f"server {name!r} must be an object")
        if entry.get("url") or entry.get("type") in _REMOTE_TYPES:
            skipped_remote.append(name)
            continue
        command = entry.get("command")
        if not isinstance(command, str) or not command:
            raise McpConfigError(f"server {name!r} must include a 'command'")
        raw_args = entry.get("args", [])
        if not isinstance(raw_args, list) or not all(
            isinstance(a, (str, int, float)) and not isinstance(a, bool)
            for a in raw_args
        ):
            raise McpConfigError(f"server {name!r} 'args' must be an array of strings")
        env = entry.get("env")
        if env is not None and (
            not isinstance(env, dict)
            or not all(isinstance(v, str) for v in env.values())
        ):
            raise McpConfigError(
                f"server {name!r} 'env' must be an object of string values"
            )
        cwd = entry.get("cwd")
        if cwd is not None and not isinstance(cwd, str):
            raise McpConfigError(f"server {name!r} 'cwd' must be a string")
        servers.append(
            McpStdioServer(
                name=name,
                command=command,
                args=tuple(str(a) for a in raw_args),
                env=dict(env) if env is not None else None,
                cwd=cwd,
            )
        )
    return servers, skipped_remote


McpInput = Union[
    str, "os.PathLike[str]", Sequence[Union[str, "os.PathLike[str]", McpStdioServer]]
]


def _servers_from_file(path: Path) -> list[McpStdioServer]:
    """The path arm: one ``.mcp.json`` config file describing many servers.
    Remote entries are skipped with a warning; zero resulting servers warns."""
    if not path.is_file():
        raise McpConfigError(f"mcp config path is not a file: {path}")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise McpConfigError(f"{path}: {exc}") from None
    try:
        servers, skipped_remote = _parse_mcp_json(data)
    except McpConfigError as exc:
        raise McpConfigError(f"{path}: {exc}") from None
    for name in skipped_remote:
        logger.warning("realtime.mcp.remote_server_skipped", server=name)
    if not servers:
        logger.warning("realtime.mcp.none_found", path=str(path))
    return servers


def resolve_mcp(mcp: McpInput | None) -> tuple[McpStdioServer, ...] | None:
    """Normalize the ``mcp`` argument to a tuple of servers — the single
    internal form every input arm converges to. A path element expands, in
    place, to that config file's servers. Duplicate names raise."""
    if mcp is None:
        return None
    items: Sequence[str | os.PathLike[str] | McpStdioServer]
    if isinstance(mcp, (str, os.PathLike)):
        items = [mcp]
    else:
        items = list(mcp)
    resolved: list[McpStdioServer] = []
    for item in items:
        if isinstance(item, McpStdioServer):
            resolved.append(item)
        elif isinstance(item, (str, os.PathLike)):
            resolved.extend(_servers_from_file(Path(item).expanduser()))
        else:
            raise TypeError(
                f"mcp elements must be McpStdioServer or a path, got {type(item).__name__}"
            )
    seen: set[str] = set()
    for server in resolved:
        if server.name in seen:
            raise McpConfigError(f"duplicate MCP server name: {server.name!r}")
        seen.add(server.name)
    return tuple(resolved)


async def connect_mcp(
    servers: Sequence[McpStdioServer],
    *,
    reserved_names: frozenset[str] = frozenset(),
    reserved_count: int = 0,
) -> ConnectedMcp:
    """Open every server (sequentially), list + build tools, and return a
    cleanup-safe handle. A server that fails to start is skipped; any
    failure or cancellation before returning tears down all opened
    subprocesses so nothing leaks."""
    parent = AsyncExitStack()
    try:
        connected: list[_ConnectedServer] = []
        for server in servers:
            child = AsyncExitStack()
            try:
                cs = await _open_stdio_server(server, child)
            except McpExtraNotInstalledError:
                await child.aclose()
                raise
            except asyncio.CancelledError:
                await child.aclose()
                raise
            except Exception:
                logger.exception(
                    "realtime.mcp.server_connect_failed",
                    server=server.name,
                    stack_info=True,
                )
                await child.aclose()
                continue
            await parent.enter_async_context(child)
            connected.append(cs)
        tools, skipped = build_mcp_tools(
            connected,
            reserved_names=set(reserved_names),
            reserved_count=reserved_count,
        )
        for sk in skipped:
            logger.warning(
                "realtime.mcp.tool_skipped", server=sk.server, tool=sk.tool, reason=sk.reason
            )
        return ConnectedMcp(tools, skipped, parent)
    except BaseException:
        await parent.aclose()
        raise


CallTool = Callable[[str, dict[str, Any]], Awaitable[Any]]

_VALID_REASONS = (
    "name_overflow",
    "name_collision",
    "invalid_schema",
    "schema_overflow",
    "count_overflow",
)


@dataclass(frozen=True)
class SkippedTool:
    """A tool dropped during build, surfaced on ConnectedMcp.skipped."""

    server: str
    tool: str
    reason: str  # one of _VALID_REASONS

    def __post_init__(self) -> None:
        if self.reason not in _VALID_REASONS:
            raise ValueError(
                f"SkippedTool.reason {self.reason!r} is not one of {_VALID_REASONS}"
            )


@dataclass
class _ConnectedServer:
    """A live MCP server: its listed tools plus a bound call function and a
    per-server lock (one ClientSession is not assumed concurrency-safe)."""

    name: str
    tools: list[Any]  # mcp.types.Tool-like: .name, .description, .inputSchema
    call_tool: CallTool
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


_NAME_UNSAFE = re.compile(r"[^A-Za-z0-9_]+")


def _exposed_name(server: str, tool: str) -> str:
    return _NAME_UNSAFE.sub("_", f"mcp__{server}__{tool}")


def _normalize_schema(input_schema: Any) -> dict[str, Any] | None:
    """Return the JSON-Schema dict reduced to the backend gate's allowed
    dialect if it is a top-level object, else None.

    Deliberately permissive, unlike the ``@tool`` builder pipeline: MCP
    servers routinely emit extra keys — ``$schema``, ``additionalProperties``,
    ``title`` — and the gate rejects the whole declaration on the first
    unknown key. Foreign servers' schemas can't be fixed by the author, so
    unknown keys are dropped instead of rejected.
    """
    if not isinstance(input_schema, dict):
        return None
    if input_schema.get("type") != "object":
        return None
    sanitized = sanitize_schema_permissive(input_schema)
    assert isinstance(sanitized, dict)
    return sanitized


def _build_proxy_tool(
    server: _ConnectedServer, mcp_tool: Any, exposed: str, schema: dict[str, Any]
) -> ClientTool:
    original = mcp_tool.name
    description = (getattr(mcp_tool, "description", None) or original)[
        :_CLIENT_TOOL_MAX_DESCRIPTION_LEN
    ]
    call_tool = server.call_tool
    lock = server.lock
    server_name = server.name

    async def handler(args: dict[str, Any]) -> dict[str, Any]:
        try:
            async with lock:
                result = await call_tool(original, args)
        except Exception:
            logger.exception(
                "realtime.mcp.tool_call_failed",
                server=server_name,
                tool=original,
                stack_info=True,
            )
            raise
        return _map_tool_result(result)

    return ClientTool(
        name=exposed, description=description, parameters=schema, handler=handler
    )


def build_mcp_tools(
    servers: Sequence[_ConnectedServer],
    *,
    reserved_names: set[str],
    reserved_count: int,
) -> tuple[list[ClientTool], list[SkippedTool]]:
    """Build proxy ClientTools across all servers, validating against the
    merged tool set: name overflow, collision (vs reserved + each other),
    invalid schema, and the session's total tool-count cap."""
    tools: list[ClientTool] = []
    skipped: list[SkippedTool] = []
    used = set(reserved_names)
    budget = _TOOL_SPECS_MAX_COUNT - reserved_count
    for server in servers:
        for mcp_tool in server.tools:
            name = _exposed_name(server.name, mcp_tool.name)
            if len(name) > _CLIENT_TOOL_MAX_NAME_LEN:
                skipped.append(SkippedTool(server.name, mcp_tool.name, "name_overflow"))
                continue
            if name in used:
                skipped.append(SkippedTool(server.name, mcp_tool.name, "name_collision"))
                continue
            schema = _normalize_schema(getattr(mcp_tool, "inputSchema", None))
            if schema is None:
                skipped.append(SkippedTool(server.name, mcp_tool.name, "invalid_schema"))
                continue
            if schema_bound_violation(schema) is not None:
                skipped.append(
                    SkippedTool(server.name, mcp_tool.name, "schema_overflow")
                )
                continue
            if len(tools) >= budget:
                skipped.append(SkippedTool(server.name, mcp_tool.name, "count_overflow"))
                continue
            used.add(name)
            tools.append(_build_proxy_tool(server, mcp_tool, name, schema))
    return tools, skipped


class McpToolError(RuntimeError):
    """An MCP tool returned isError=true; surfaced as a client-tool failure."""


def _collect_text(result: Any) -> str:
    blocks = getattr(result, "content", None) or []
    parts = [
        b.text
        for b in blocks
        if getattr(b, "type", None) == "text" and getattr(b, "text", None)
    ]
    return "\n".join(parts)


def _map_tool_result(result: Any) -> dict[str, Any]:
    """Map an MCP CallToolResult to the dict a ClientTool handler returns.
    Raises McpToolError when the tool reports an error."""
    if getattr(result, "isError", False):
        raise McpToolError(_collect_text(result) or "MCP tool reported an error")
    out: dict[str, Any] = {}
    structured = getattr(result, "structuredContent", None)
    if structured is not None:
        out["structured"] = structured
    text = _collect_text(result)
    if text:
        out["text"] = text
    non_text = [
        b.type
        for b in (getattr(result, "content", None) or [])
        if getattr(b, "type", None) != "text"
    ]
    if non_text:
        out["non_text"] = non_text
    return out or {"text": ""}


class McpExtraNotInstalledError(ExtraNotInstalledError):
    """The optional `mcp` extra is required for live MCP connections."""


_EXTRA_HINT = (
    "MCP support requires the 'mcp' extra. Install with: "
    "pip install 'cosmo-ai-sdk[mcp]'"
)


async def _open_stdio_server(
    server: McpStdioServer, stack: AsyncExitStack
) -> _ConnectedServer:
    """Spawn one stdio MCP server, initialize, and list its tools. Transport +
    session are entered into `stack`, which owns their teardown."""
    try:
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client
    except ImportError as exc:
        raise McpExtraNotInstalledError(_EXTRA_HINT) from exc

    params = StdioServerParameters(
        command=server.command,
        args=list(server.args),
        env=dict(server.env) if server.env else None,
        cwd=server.cwd,
    )
    read, write = await stack.enter_async_context(stdio_client(params))
    session = await stack.enter_async_context(ClientSession(read, write))
    await session.initialize()
    listed = await session.list_tools()

    async def call_tool(tool_name: str, args: dict[str, Any]) -> Any:
        return await session.call_tool(tool_name, args)

    return _ConnectedServer(
        name=server.name, tools=list(listed.tools), call_tool=call_tool
    )


class ConnectedMcp:
    """A per-session live MCP handle: the proxy tools, the build diagnostics,
    and idempotent teardown of every server subprocess."""

    def __init__(
        self,
        tools: list[ClientTool],
        skipped: list[SkippedTool],
        stack: AsyncExitStack,
    ) -> None:
        self.tools = tools
        self.skipped = skipped
        self._stack = stack
        self._closed = False

    async def aclose(self) -> None:
        if self._closed:
            return
        self._closed = True
        await self._stack.aclose()
