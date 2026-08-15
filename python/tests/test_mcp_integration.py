from contextlib import AsyncExitStack

import pytest

import cosmo_ai.client as client_mod
from cosmo_ai.client import RealtimeClient
from cosmo_ai.mcp._engine import ConnectedMcp
from cosmo_ai.mcp import McpStdioServer
from cosmo_ai._internal.protocol import ClientTool, InlineAgentConfig, SessionConfig, SessionParams
from cosmo_ai.session import DisconnectReason, RealtimeSession


def _bare_config():
    return SessionConfig(
        agent=InlineAgentConfig(), session=SessionParams()
    )


@pytest.mark.asyncio
async def test_finish_invokes_on_close():
    calls: list[int] = []

    async def on_close():
        calls.append(1)

    s = RealtimeSession(config=_bare_config(), on_close=on_close)
    await s._finish(reason=DisconnectReason.CLIENT_ENDED)
    assert calls == [1]
    # idempotent: second _finish is a no-op (already terminal)
    await s._finish(reason=DisconnectReason.CLIENT_ENDED)
    assert calls == [1]


@pytest.mark.asyncio
async def test_on_close_failure_is_isolated():
    async def on_close():
        raise RuntimeError("teardown boom")

    s = RealtimeSession(config=_bare_config(), on_close=on_close)
    # must not raise
    await s._finish(reason=DisconnectReason.CLIENT_CLOSED)
    assert s._terminal is True


# RealtimeAgent.mcp wiring — connect/merge/teardown


def _fake_connect_mcp(closed: list[str]):
    """Stands in for connect_mcp: yields one proxy tool + records teardown."""

    async def fake(servers, *, reserved_names=frozenset(), reserved_count=0):
        async def handler(args):
            return {"text": "ok"}

        tool = ClientTool(
            name="mcp__fake__ping",
            description="ping",
            parameters={"type": "object", "properties": {}},
            handler=handler,
        )
        stack = AsyncExitStack()

        class _S:
            async def __aenter__(s):
                return s

            async def __aexit__(s, *e):
                closed.append("fake")

        await stack.enter_async_context(_S())
        return ConnectedMcp([tool], [], stack)

    return fake


@pytest.mark.asyncio
async def test_start_merges_mcp_tools_and_tears_down(monkeypatch):
    closed: list[str] = []
    monkeypatch.setattr(client_mod, "connect_mcp", _fake_connect_mcp(closed))
    client = RealtimeClient(api_key="sk-x")

    captured: dict = {}

    async def fake_start(config):
        captured["tools"] = [t.name for t in (config.agent.tools or [])]
        raise AssertionError("stop after config build")  # halt before real network

    agent = client.agent(instructions="hi", mcp=[McpStdioServer(name="fake", command="x")])
    handle = agent.start()
    with pytest.raises(AssertionError, match="stop after config build"):
        # patch the bound post-start used inside _open
        monkeypatch.setattr(handle, "_post_session_start", fake_start)
        await handle
    assert "mcp__fake__ping" in captured["tools"]
    assert closed == ["fake"]  # start failed → MCP torn down


def test_agent_resolves_mcp_servers():
    client = RealtimeClient(api_key="sk-x")
    servers = [McpStdioServer(name="fake", command="x")]
    assert client.agent(instructions="hi").mcp is None
    assert client.agent(instructions="hi", mcp=servers).mcp == tuple(servers)
