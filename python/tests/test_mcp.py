import asyncio
import importlib
import inspect
import json
from dataclasses import dataclass
from pathlib import Path

import cosmo_ai as cr
import pytest

import cosmo_ai.mcp._engine as mcp_mod
from cosmo_ai.mcp._engine import (
    McpConfigError,
    McpExtraNotInstalledError,
    McpToolError,
    SkippedTool,
    McpStdioServer,
    _ConnectedServer,
    _exposed_name,
    _map_tool_result,
    _normalize_schema,
    _parse_mcp_json,
    build_mcp_tools,
)
from cosmo_ai._internal.protocol import _TOOL_SPECS_MAX_COUNT


def test_parse_stdio_server():
    servers, skipped = _parse_mcp_json(
        {"mcpServers": {"fs": {"command": "npx", "args": ["-y", "server-fs", "/tmp"]}}}
    )
    assert skipped == []
    assert servers == [McpStdioServer(name="fs", command="npx", args=("-y", "server-fs", "/tmp"))]


def test_parse_skips_remote_entries():
    servers, skipped = _parse_mcp_json(
        {
            "mcpServers": {
                "local": {"command": "npx", "args": ["x"]},
                "remote_url": {"url": "https://example.com/mcp"},
                "remote_type": {"type": "http", "command": "ignored"},
            }
        }
    )
    assert [s.name for s in servers] == ["local"]
    assert sorted(skipped) == ["remote_type", "remote_url"]


def test_parse_rejects_missing_mcp_servers():
    with pytest.raises(McpConfigError):
        _parse_mcp_json({"servers": {}})


def test_parse_rejects_server_without_command():
    with pytest.raises(McpConfigError):
        _parse_mcp_json({"mcpServers": {"bad": {"args": ["x"]}}})


def test_parse_rejects_string_args():
    # A bare string would otherwise iterate per-character into argv.
    with pytest.raises(McpConfigError, match="args"):
        _parse_mcp_json({"mcpServers": {"bad": {"command": "npx", "args": "-y pkg"}}})


def test_parse_rejects_non_scalar_args_elements():
    with pytest.raises(McpConfigError, match="args"):
        _parse_mcp_json(
            {"mcpServers": {"bad": {"command": "npx", "args": [{"flag": True}]}}}
        )


def test_parse_coerces_numeric_args():
    servers, _ = _parse_mcp_json(
        {"mcpServers": {"ok": {"command": "srv", "args": ["--port", 8080]}}}
    )
    assert servers[0].args == ("--port", "8080")


def test_parse_rejects_malformed_env_and_cwd():
    with pytest.raises(McpConfigError, match="env"):
        _parse_mcp_json({"mcpServers": {"bad": {"command": "x", "env": "PATH=1"}}})
    with pytest.raises(McpConfigError, match="env"):
        _parse_mcp_json({"mcpServers": {"bad": {"command": "x", "env": {"A": 1}}}})
    with pytest.raises(McpConfigError, match="cwd"):
        _parse_mcp_json({"mcpServers": {"bad": {"command": "x", "cwd": 5}}})


def _write_config(tmp_path: Path, payload: dict) -> Path:
    cfg = tmp_path / ".mcp.json"
    cfg.write_text(json.dumps(payload))
    return cfg


def test_resolve_none_is_none():
    assert mcp_mod.resolve_mcp(None) is None


def test_resolve_reads_a_config_file(tmp_path: Path):
    cfg = _write_config(
        tmp_path,
        {"mcpServers": {"fs": {"command": "npx", "args": ["-y", "s"], "env": {"K": "V"}}}},
    )
    assert mcp_mod.resolve_mcp(cfg) == (
        McpStdioServer(name="fs", command="npx", args=("-y", "s"), env={"K": "V"}),
    )
    assert mcp_mod.resolve_mcp(str(cfg)) == mcp_mod.resolve_mcp(cfg)


def test_resolve_missing_file_raises(tmp_path: Path):
    with pytest.raises(McpConfigError, match="not a file"):
        mcp_mod.resolve_mcp(tmp_path / "absent.json")


def test_resolve_malformed_json_raises_with_path(tmp_path: Path):
    cfg = tmp_path / ".mcp.json"
    cfg.write_text("{not json")
    with pytest.raises(McpConfigError, match=r"\.mcp\.json"):
        mcp_mod.resolve_mcp(cfg)


def test_resolve_expands_path_elements_in_place(tmp_path: Path):
    cfg = _write_config(tmp_path, {"mcpServers": {"fs": {"command": "npx"}}})
    inline = McpStdioServer(name="internal", command="x")
    assert mcp_mod.resolve_mcp([inline, cfg]) == (
        inline,
        McpStdioServer(name="fs", command="npx"),
    )


def test_resolve_duplicate_names_across_elements_raise(tmp_path: Path):
    cfg = _write_config(tmp_path, {"mcpServers": {"fs": {"command": "npx"}}})
    with pytest.raises(McpConfigError, match="duplicate MCP server name"):
        mcp_mod.resolve_mcp([McpStdioServer(name="fs", command="x"), cfg])


def test_resolve_rejects_non_server_non_path_elements():
    with pytest.raises(TypeError, match="must be McpStdioServer or a path"):
        mcp_mod.resolve_mcp([42])  # type: ignore[list-item]


def test_resolve_empty_config_warns_and_attaches_none(tmp_path: Path):
    import structlog.testing

    cfg = _write_config(tmp_path, {"mcpServers": {}})
    with structlog.testing.capture_logs() as logs:
        assert mcp_mod.resolve_mcp(cfg) == ()
    assert any(log["event"] == "realtime.mcp.none_found" for log in logs)


@dataclass
class FakeMcpTool:
    name: str
    description: str | None
    inputSchema: dict


def _obj_schema(**props):
    return {"type": "object", "properties": props}


def _server(name, tools):
    async def call_tool(tool_name, args):  # pragma: no cover - not invoked here
        raise AssertionError("not called in build tests")

    return _ConnectedServer(name=name, tools=tools, call_tool=call_tool, lock=asyncio.Lock())


def test_exposed_name_namespaces_and_normalizes():
    assert _exposed_name("gh", "list issues") == "mcp__gh__list_issues"
    assert _exposed_name("a.b", "x/y") == "mcp__a_b__x_y"


def test_normalize_schema_accepts_object_rejects_others():
    s = _obj_schema(a={"type": "string"})
    assert _normalize_schema(s) == s
    assert _normalize_schema({"type": "array"}) is None
    assert _normalize_schema(None) is None


def test_normalize_schema_strips_keys_the_backend_gate_rejects():
    raw = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "title": "Args",
        "additionalProperties": False,
        "required": ["path"],
        "properties": {
            "path": {"type": "string", "description": "a path", "title": "Path"},
            "mode": {"anyOf": [{"type": "string", "enum": ["r", "w"]}, {"type": "null"}]},
            "tags": {"type": "array", "items": {"type": "string", "$comment": "x"}},
        },
    }
    assert _normalize_schema(raw) == {
        "type": "object",
        "required": ["path"],
        "properties": {
            "path": {"type": "string", "description": "a path"},
            "mode": {"anyOf": [{"type": "string", "enum": ["r", "w"]}, {"type": "null"}]},
            "tags": {"type": "array", "items": {"type": "string"}},
        },
    }


def test_build_basic_tool():
    srv = _server("fs", [FakeMcpTool("read", "Read a file", _obj_schema(p={"type": "string"}))])
    tools, skipped = build_mcp_tools([srv], reserved_names=set(), reserved_count=0)
    assert skipped == []
    assert [t.name for t in tools] == ["mcp__fs__read"]
    assert tools[0].parameters == _obj_schema(p={"type": "string"})
    assert tools[0].description == "Read a file"
    assert tools[0].handler is not None


def test_build_skips_invalid_schema():
    srv = _server("fs", [FakeMcpTool("bad", "d", {"type": "array"})])
    tools, skipped = build_mcp_tools([srv], reserved_names=set(), reserved_count=0)
    assert tools == []
    assert skipped == [SkippedTool("fs", "bad", "invalid_schema")]


def test_build_skips_schema_past_depth_bound():
    # The backend would reject an over-deep tool per-tool at connect; the
    # proxy skips it at build time instead.
    deep: dict = {"type": "object"}
    node = deep
    for _ in range(8):
        node["properties"] = {"n": {"type": "object"}}
        node = node["properties"]["n"]
    srv = _server("fs", [FakeMcpTool("deep", "d", deep)])
    tools, skipped = build_mcp_tools([srv], reserved_names=set(), reserved_count=0)
    assert tools == []
    assert skipped == [SkippedTool("fs", "deep", "schema_overflow")]


def test_build_skips_schema_past_byte_budget():
    # An over-bytes schema would fail request validation and reject the whole
    # session start — the one bound where the skip prevents a session bounce.
    fat = {"type": "object", "description": "x" * 9000}
    srv = _server("fs", [FakeMcpTool("fat", "d", fat)])
    tools, skipped = build_mcp_tools([srv], reserved_names=set(), reserved_count=0)
    assert tools == []
    assert skipped == [SkippedTool("fs", "fat", "schema_overflow")]


def test_build_skips_schema_past_property_bound():
    # 65 properties across the schema; the property cap is global (64).
    wide = {
        "type": "object",
        "properties": {f"p{i}": {"type": "string"} for i in range(65)},
    }
    srv = _server("fs", [FakeMcpTool("wide", "d", wide)])
    tools, skipped = build_mcp_tools([srv], reserved_names=set(), reserved_count=0)
    assert tools == []
    assert skipped == [SkippedTool("fs", "wide", "schema_overflow")]


def test_build_skips_name_collision_with_reserved_and_within():
    srv = _server(
        "fs",
        [
            FakeMcpTool("read", "d", _obj_schema()),
            FakeMcpTool("read", "d2", _obj_schema()),  # dup within server
        ],
    )
    tools, skipped = build_mcp_tools(
        [srv], reserved_names={"mcp__fs__read"}, reserved_count=1
    )
    assert tools == []
    assert skipped == [
        SkippedTool("fs", "read", "name_collision"),
        SkippedTool("fs", "read", "name_collision"),
    ]


def test_build_skips_name_overflow():
    long = "x" * 70
    srv = _server("fs", [FakeMcpTool(long, "d", _obj_schema())])
    tools, skipped = build_mcp_tools([srv], reserved_names=set(), reserved_count=0)
    assert tools == []
    assert skipped == [SkippedTool("fs", long, "name_overflow")]


def test_build_enforces_total_cap():
    tools_in = [FakeMcpTool(f"t{i}", "d", _obj_schema()) for i in range(5)]
    srv = _server("s", tools_in)
    tools, skipped = build_mcp_tools(
        [srv], reserved_names=set(), reserved_count=_TOOL_SPECS_MAX_COUNT - 2
    )
    assert len(tools) == 2
    assert [s.reason for s in skipped] == ["count_overflow"] * 3


def test_build_truncates_long_description():
    srv = _server("s", [FakeMcpTool("t", "d" * 5000, _obj_schema())])
    tools, _ = build_mcp_tools([srv], reserved_names=set(), reserved_count=0)
    assert len(tools[0].description) == 2048


# Tests for McpToolError and result mapping


@dataclass
class TextBlock:
    text: str
    type: str = "text"


@dataclass
class ImageBlock:
    type: str = "image"


@dataclass
class FakeResult:
    content: list
    isError: bool = False
    structuredContent: dict | None = None


def test_map_text_blocks():
    out = _map_tool_result(FakeResult(content=[TextBlock("a"), TextBlock("b")]))
    assert out == {"text": "a\nb"}


def test_map_structured_content_preferred_and_kept():
    out = _map_tool_result(
        FakeResult(content=[TextBlock("hi")], structuredContent={"k": 1})
    )
    assert out == {"structured": {"k": 1}, "text": "hi"}


def test_map_notes_non_text_blocks():
    out = _map_tool_result(FakeResult(content=[TextBlock("t"), ImageBlock()]))
    assert out == {"text": "t", "non_text": ["image"]}


def test_map_empty_content():
    assert _map_tool_result(FakeResult(content=[])) == {"text": ""}


def test_map_is_error_raises():
    with pytest.raises(McpToolError, match="boom"):
        _map_tool_result(FakeResult(content=[TextBlock("boom")], isError=True))


# --- live connection tests ---


def _fake_open(per_server_tools, *, fail_on=None, record_closed=None):
    """Build a fake _open_stdio_server that enters a sentinel into the stack so
    we can assert teardown, and optionally fails for a given server name."""

    async def _open(server, stack):
        if fail_on is not None and server.name == fail_on:
            raise RuntimeError(f"connect failed: {server.name}")

        class _Sentinel:
            async def __aenter__(self_):
                return self_

            async def __aexit__(self_, *exc):
                if record_closed is not None:
                    record_closed.append(server.name)

        await stack.enter_async_context(_Sentinel())

        async def call_tool(tool_name, args):  # pragma: no cover
            raise AssertionError("unused")

        return mcp_mod._ConnectedServer(
            name=server.name,
            tools=per_server_tools.get(server.name, []),
            call_tool=call_tool,
            lock=asyncio.Lock(),
        )

    return _open


@pytest.mark.asyncio
async def test_connect_builds_tools_and_closes(monkeypatch):
    servers = [McpStdioServer("fs", "x")]
    tool = FakeMcpTool("read", "d", _obj_schema())
    closed: list[str] = []
    monkeypatch.setattr(
        mcp_mod, "_open_stdio_server", _fake_open({"fs": [tool]}, record_closed=closed)
    )
    connected = await mcp_mod.connect_mcp(servers)
    assert [t.name for t in connected.tools] == ["mcp__fs__read"]
    await connected.aclose()
    await connected.aclose()  # idempotent
    assert closed == ["fs"]  # closed exactly once


@pytest.mark.asyncio
async def test_connect_skips_failed_server_and_keeps_others(monkeypatch):
    servers = [McpStdioServer("ok", "x"), McpStdioServer("bad", "y")]
    closed: list[str] = []
    monkeypatch.setattr(
        mcp_mod,
        "_open_stdio_server",
        _fake_open(
            {"ok": [FakeMcpTool("t", "d", _obj_schema())]},
            fail_on="bad",
            record_closed=closed,
        ),
    )
    connected = await mcp_mod.connect_mcp(servers)
    assert [t.name for t in connected.tools] == ["mcp__ok__t"]
    await connected.aclose()
    assert closed == ["ok"]


@pytest.mark.asyncio
async def test_connect_reserved_names_force_collision(monkeypatch):
    servers = [McpStdioServer("fs", "x")]
    monkeypatch.setattr(
        mcp_mod,
        "_open_stdio_server",
        _fake_open({"fs": [FakeMcpTool("read", "d", _obj_schema())]}),
    )
    connected = await mcp_mod.connect_mcp(
        servers, reserved_names=frozenset({"mcp__fs__read"}), reserved_count=1
    )
    assert connected.tools == []
    assert connected.skipped == [SkippedTool("fs", "read", "name_collision")]
    await connected.aclose()


@pytest.mark.asyncio
async def test_connect_propagates_mcp_extra_not_installed(monkeypatch):
    async def _fail(server, stack):
        raise McpExtraNotInstalledError("hint")

    monkeypatch.setattr(mcp_mod, "_open_stdio_server", _fail)
    servers = [McpStdioServer("s", "x")]
    with pytest.raises(McpExtraNotInstalledError):
        await mcp_mod.connect_mcp(servers)


@pytest.mark.asyncio
async def test_connect_cancellation_propagates_and_tears_down(monkeypatch):
    closed: list[str] = []

    async def _open(server, stack):
        if server.name == "first":
            class _Sentinel:
                async def __aenter__(self_):
                    return self_

                async def __aexit__(self_, *exc):
                    closed.append(server.name)

            await stack.enter_async_context(_Sentinel())

            async def call_tool(tool_name, args):  # pragma: no cover
                raise AssertionError("unused")

            return mcp_mod._ConnectedServer(
                name=server.name,
                tools=[],
                call_tool=call_tool,
                lock=asyncio.Lock(),
            )
        raise asyncio.CancelledError()

    monkeypatch.setattr(mcp_mod, "_open_stdio_server", _open)
    servers = [McpStdioServer("first", "x"), McpStdioServer("second", "y")]
    with pytest.raises(asyncio.CancelledError):
        await mcp_mod.connect_mcp(servers)
    assert closed == ["first"]


def test_public_surface():
    # The concept lives at cosmo_ai.mcp; nothing rides at the root.
    import cosmo_ai.mcp as mcp_facade

    assert mcp_facade.__all__ == [
        "McpConfigError",
        "McpExtraNotInstalledError",
        "McpInput",
        "McpStdioServer",
    ]
    for name in ("McpStdioServer", "McpConfigError", "McpToolError", "ConnectedMcp"):
        assert not hasattr(cr, name), name


def test_module_imports_without_extra():
    # The engine must not import the `mcp` package at module top level.
    mod = importlib.import_module("cosmo_ai.mcp._engine")
    assert hasattr(mod, "resolve_mcp")
    # The lazy import lives inside _open_stdio_server, not at module scope.
    src = inspect.getsource(mod)
    top_level = [
        line
        for line in src.splitlines()
        if line.startswith("import mcp") or line.startswith("from mcp ")
    ]
    assert top_level == [], f"mcp imported at top level: {top_level}"
