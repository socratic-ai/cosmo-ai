"""Client-tool execution: handler registration over the RPC transport, the
``{ok, result, error}`` reply envelope, the agent-only caller-guard, and the
reply size cap."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from cosmo_ai import WebSearchTool
from cosmo_ai.tools._dispatch import _invoke_handler
from cosmo_ai.tools import ClientTool
from cosmo_ai._internal.rpc import (
    MAX_REPLY_BYTES,
    TRUNCATION_MARKER_KEY,
    TRUNCATION_MARKER_NOTE,
    TRUNCATION_SUFFIX,
    reply_envelope,
    shrink_strings,
)
from cosmo_ai._internal.transport import RpcMethodError
from cosmo_ai._internal.hooks import (
    HookEngine,
    PostToolUseContext,
    PreToolUseContext,
    PreToolUseResult,
    ToolDenied,
    ToolOk,
    post_tool_use,
    pre_tool_use,
)

from .fakes import FakeRpcInvocation, FakeTransport, start_fake_session

_AGENT_IDENTITY = "agent-1"
_HUMAN_IDENTITY = "human-1"


def _tool(name: str, handler: Any) -> ClientTool:
    return ClientTool(
        name=name,
        description=f"{name} tool",
        parameters={"type": "object", "properties": {}},
        handler=handler,
    )


async def _start_with_agent(tools: list[ClientTool | WebSearchTool]) -> FakeTransport:
    """Start a fake session declaring ``tools`` and return its transport, whose
    registered RPC methods these tests invoke directly."""
    harness = await start_fake_session(tools=tools)
    assert harness.session is not None
    return harness.transport


def _registered(transport: FakeTransport, name: str) -> Any:
    method = transport.rpc_methods.get(name)
    assert method is not None, f"no RPC method registered for {name!r}"
    return method


def test_handler_runs_with_decoded_args_and_returns_ok_envelope() -> None:
    async def scenario() -> None:
        seen_args: dict[str, Any] = {}

        async def handler(args: dict[str, Any]) -> dict[str, Any]:
            seen_args.update(args)
            return {"celsius": 21, "city": args["city"]}

        transport = await _start_with_agent([_tool("get_weather", handler)])
        method = _registered(transport, "get_weather")

        reply = await method(
            FakeRpcInvocation(
                caller_identity=_AGENT_IDENTITY,
                payload=json.dumps({"city": "Paris", "units": "metric"}),
            )
        )

        assert seen_args == {"city": "Paris", "units": "metric"}
        assert json.loads(reply) == {
            "ok": True,
            "result": {"celsius": 21, "city": "Paris"},
            "error": None,
        }

    asyncio.run(scenario())


def test_empty_payload_decodes_to_empty_args() -> None:
    async def scenario() -> None:
        async def handler(args: dict[str, Any]) -> dict[str, Any]:
            return {"arg_count": len(args)}

        transport = await _start_with_agent([_tool("now", handler)])
        method = _registered(transport, "now")

        reply = await method(
            FakeRpcInvocation(caller_identity=_AGENT_IDENTITY, payload="")
        )
        assert json.loads(reply) == {
            "ok": True,
            "result": {"arg_count": 0},
            "error": None,
        }

    asyncio.run(scenario())


def test_handler_exception_yields_error_envelope() -> None:
    async def scenario() -> None:
        async def handler(args: dict[str, Any]) -> dict[str, Any]:
            raise RuntimeError("disk on fire")

        transport = await _start_with_agent([_tool("read_file", handler)])
        method = _registered(transport, "read_file")

        reply = await method(
            FakeRpcInvocation(
                caller_identity=_AGENT_IDENTITY, payload=json.dumps({"path": "/x"})
            )
        )
        assert json.loads(reply) == {
            "ok": False,
            "result": None,
            "error": "disk on fire",
        }

    asyncio.run(scenario())


def test_non_object_args_rejected_without_calling_handler() -> None:
    async def scenario() -> None:
        called = False

        async def handler(args: dict[str, Any]) -> dict[str, Any]:
            nonlocal called
            called = True
            return {}

        transport = await _start_with_agent([_tool("t", handler)])
        method = _registered(transport, "t")

        reply = await method(
            FakeRpcInvocation(caller_identity=_AGENT_IDENTITY, payload="[1, 2, 3]")
        )
        decoded = json.loads(reply)
        assert decoded["ok"] is False
        assert decoded["result"] is None
        assert "JSON object" in decoded["error"]
        assert called is False

    asyncio.run(scenario())


def test_caller_guard_rejects_non_agent_caller() -> None:
    async def scenario() -> None:
        called = False

        async def handler(args: dict[str, Any]) -> dict[str, Any]:
            nonlocal called
            called = True
            return {}

        transport = await _start_with_agent([_tool("t", handler)])
        method = _registered(transport, "t")

        # A non-agent caller is rejected: the handler never runs, and the
        # transport-neutral RpcMethodError maps to the transport's RPC error.
        with pytest.raises(RpcMethodError) as excinfo:
            await method(
                FakeRpcInvocation(
                    caller_identity=_HUMAN_IDENTITY,
                    payload=json.dumps({}),
                    caller_is_agent=False,
                )
            )
        assert "session agent" in excinfo.value.message
        assert called is False

    asyncio.run(scenario())


def test_caller_guard_rejects_unknown_caller() -> None:
    async def scenario() -> None:
        async def handler(args: dict[str, Any]) -> dict[str, Any]:
            return {}

        transport = await _start_with_agent([_tool("t", handler)])
        method = _registered(transport, "t")

        # A caller the transport could not resolve to the agent is rejected.
        with pytest.raises(RpcMethodError):
            await method(
                FakeRpcInvocation(
                    caller_identity="ghost",
                    payload=json.dumps({}),
                    caller_is_agent=False,
                )
            )

    asyncio.run(scenario())


def test_oversized_result_is_delivered_truncated_not_lost() -> None:
    async def scenario() -> None:
        blob = "x" * 20_000

        async def handler(args: dict[str, Any]) -> dict[str, Any]:
            return {"blob": blob, "unit": "celsius"}

        transport = await _start_with_agent([_tool("dump", handler)])
        method = _registered(transport, "dump")

        reply = await method(
            FakeRpcInvocation(caller_identity=_AGENT_IDENTITY, payload=json.dumps({}))
        )
        assert len(reply.encode("utf-8")) <= MAX_REPLY_BYTES
        decoded = json.loads(reply)
        assert decoded["ok"] is True
        assert decoded["error"] is None
        # The partial answer survives, and the marker tells the model it is partial.
        marker = decoded["result"][TRUNCATION_MARKER_KEY]
        assert marker["note"] == TRUNCATION_MARKER_NOTE
        assert marker["original_bytes"] > marker["kept_bytes"] > 0
        assert decoded["result"]["unit"] == "celsius"
        assert decoded["result"]["blob"].startswith("xxx")
        assert decoded["result"]["blob"].endswith(TRUNCATION_SUFFIX)
        assert len(decoded["result"]["blob"]) < len(blob)

    asyncio.run(scenario())


def test_many_short_strings_beside_a_long_one_keep_every_entry() -> None:
    """The shape the never-grow rule exists for, end to end: short strings near
    the suffix's own length beside one long string. Its invariant is pinned by
    ``test_the_shortened_size_never_falls_as_the_allowance_rises``."""

    async def scenario() -> None:
        result: dict[str, Any] = {f"k{i}": "a" * 8 for i in range(20)}
        result["big"] = "b" * 32_768
        result["pad"] = [0] * 4_905

        async def handler(args: dict[str, Any]) -> dict[str, Any]:
            return result

        transport = await _start_with_agent([_tool("dump", handler)])
        method = _registered(transport, "dump")

        reply = await method(
            FakeRpcInvocation(caller_identity=_AGENT_IDENTITY, payload=json.dumps({}))
        )
        assert len(reply.encode("utf-8")) <= MAX_REPLY_BYTES
        decoded = json.loads(reply)["result"]
        assert set(decoded) == set(result) | {TRUNCATION_MARKER_KEY}
        # Nearly the whole budget is spent on the answer, not surrendered.
        assert len(reply.encode("utf-8")) > MAX_REPLY_BYTES - 512

    asyncio.run(scenario())


def test_the_shortened_size_never_falls_as_the_allowance_rises() -> None:
    """The property ``success_reply``'s binary search prunes on. Without it a
    smaller allowance can yield a larger reply, and the search steps over the
    fitting window and reports that nothing fits."""
    result: dict[str, Any] = {f"k{i}": "a" * 8 for i in range(20)}
    result["big"] = "b" * 32_768
    result["pad"] = [0] * 4_905
    sizes = [
        len(reply_envelope(ok=True, result=shrink_strings(result, m), error=None))
        for m in range(120)
    ]
    assert sizes == sorted(sizes)


def test_oversized_result_without_long_strings_drops_entries_biggest_first() -> None:
    async def scenario() -> None:
        rows = list(range(1_000_000, 1_004_000))

        async def handler(args: dict[str, Any]) -> dict[str, Any]:
            return {"rows": rows, "count": len(rows)}

        transport = await _start_with_agent([_tool("dump", handler)])
        method = _registered(transport, "dump")

        reply = await method(
            FakeRpcInvocation(caller_identity=_AGENT_IDENTITY, payload=json.dumps({}))
        )
        assert len(reply.encode("utf-8")) <= MAX_REPLY_BYTES
        decoded = json.loads(reply)
        assert decoded["ok"] is True
        assert decoded["error"] is None
        assert decoded["result"]["count"] == 4000
        assert "rows" not in decoded["result"]
        marker = decoded["result"][TRUNCATION_MARKER_KEY]
        assert marker["note"] == TRUNCATION_MARKER_NOTE
        # The dropped list is the whole overflow, so almost nothing survived.
        assert marker["original_bytes"] > 10 * marker["kept_bytes"]

    asyncio.run(scenario())


def test_a_result_that_fits_is_passed_through_unchanged() -> None:
    async def scenario() -> None:
        async def handler(args: dict[str, Any]) -> dict[str, Any]:
            return {"temp_c": 21.5}

        transport = await _start_with_agent([_tool("weather", handler)])
        method = _registered(transport, "weather")

        reply = await method(
            FakeRpcInvocation(caller_identity=_AGENT_IDENTITY, payload=json.dumps({}))
        )
        assert json.loads(reply) == {
            "ok": True,
            "result": {"temp_c": 21.5},
            "error": None,
        }

    asyncio.run(scenario())


def test_long_error_message_is_truncated_within_cap() -> None:
    async def scenario() -> None:
        async def handler(args: dict[str, Any]) -> dict[str, Any]:
            raise ValueError("e" * 30_000)

        transport = await _start_with_agent([_tool("boom", handler)])
        method = _registered(transport, "boom")

        reply = await method(
            FakeRpcInvocation(caller_identity=_AGENT_IDENTITY, payload=json.dumps({}))
        )
        decoded = json.loads(reply)
        assert decoded["ok"] is False
        assert decoded["error"].endswith(TRUNCATION_SUFFIX)
        assert len(reply.encode("utf-8")) <= MAX_REPLY_BYTES

    asyncio.run(scenario())


def test_error_message_is_cut_on_a_scalar_boundary() -> None:
    """Astral scalars survive whole. Cutting on UTF-16 units would strand a lone
    surrogate; cutting on grapheme clusters would land somewhere the sibling
    SDKs do not."""

    async def scenario() -> None:
        async def handler(args: dict[str, Any]) -> dict[str, Any]:
            raise ValueError("🙂" * 20_000)

        transport = await _start_with_agent([_tool("boom", handler)])
        method = _registered(transport, "boom")

        reply = await method(
            FakeRpcInvocation(caller_identity=_AGENT_IDENTITY, payload=json.dumps({}))
        )
        assert len(reply.encode("utf-8")) <= MAX_REPLY_BYTES
        message = json.loads(reply)["error"]
        kept = message[: -len(TRUNCATION_SUFFIX)]
        assert message.endswith(TRUNCATION_SUFFIX)
        assert kept == "🙂" * len(kept)

    asyncio.run(scenario())


def test_a_long_key_is_weighed_with_its_value_when_dropping() -> None:
    """The entry that overflows is the one with the enormous key, so it is the
    one that goes. Ranking on the value alone drops the wrong entry, then runs
    out of entries and returns nothing but the marker."""

    async def scenario() -> None:
        result: dict[str, Any] = {"K" * 15_200: 0, "x": [0] * 100}

        async def handler(args: dict[str, Any]) -> dict[str, Any]:
            return result

        transport = await _start_with_agent([_tool("dump", handler)])
        method = _registered(transport, "dump")

        reply = await method(
            FakeRpcInvocation(caller_identity=_AGENT_IDENTITY, payload=json.dumps({}))
        )
        assert len(reply.encode("utf-8")) <= MAX_REPLY_BYTES
        decoded = json.loads(reply)["result"]
        assert decoded["x"] == [0] * 100
        assert "K" * 15_200 not in decoded

    asyncio.run(scenario())


async def _ok_handler(args):
    return {"echo": args}


@pytest.mark.asyncio
async def test_pre_tool_use_deny_blocks_handler_and_posts_denied():
    posts: list[object] = []
    called = False

    @pre_tool_use
    def deny(ctx: PreToolUseContext) -> PreToolUseResult:
        return PreToolUseResult(permission="deny", reason="blocked")

    @post_tool_use
    def observe(ctx: PostToolUseContext) -> None:
        posts.append(ctx.outcome)

    reg = HookEngine([deny, observe])

    async def handler(args):
        nonlocal called
        called = True
        return {"x": 1}

    reply = await _invoke_handler(
        handler, json.dumps({"a": 1}), tool_name="delete_x", hooks=reg, session_id="s"
    )
    env = json.loads(reply)
    assert env["ok"] is False and env["error"] == "blocked"
    assert called is False
    assert posts == [ToolDenied(reason="blocked")]


@pytest.mark.asyncio
async def test_pre_tool_use_rewrites_arguments():
    received: dict = {}

    @pre_tool_use
    def rewrite(ctx: PreToolUseContext) -> PreToolUseResult:
        return PreToolUseResult(updated_arguments={"a": 99})

    reg = HookEngine([rewrite])

    async def handler(args):
        received.update(args)
        return {"ok": True}

    reply = await _invoke_handler(
        handler, json.dumps({"a": 1}), tool_name="t", hooks=reg, session_id="s"
    )
    assert json.loads(reply)["ok"] is True
    assert received == {"a": 99}


@pytest.mark.asyncio
async def test_post_tool_use_sees_ok_outcome():
    posts: list[object] = []

    @post_tool_use
    def observe(ctx: PostToolUseContext) -> None:
        posts.append(ctx.outcome)

    reg = HookEngine([observe])

    reply = await _invoke_handler(
        _ok_handler, json.dumps({"a": 1}), tool_name="t", hooks=reg, session_id="s"
    )
    assert json.loads(reply)["ok"] is True
    assert posts == [ToolOk(result={"echo": {"a": 1}})]


@pytest.mark.asyncio
async def test_post_tool_use_reports_a_truncated_success_as_ok():
    posts: list[object] = []

    @post_tool_use
    def observe(ctx: PostToolUseContext) -> None:
        posts.append(ctx.outcome)

    reg = HookEngine([observe])

    blob = "x" * 20000  # exceeds MAX_REPLY_BYTES

    async def huge(args):
        return {"blob": blob}

    reply = await _invoke_handler(
        huge, json.dumps({}), tool_name="t", hooks=reg, session_id="s"
    )
    assert json.loads(reply)["ok"] is True
    # The cap is a transport property; a local observer sees what the handler
    # actually returned, not what fit on the wire.
    assert len(posts) == 1
    assert posts[0] == ToolOk(result={"blob": blob})


@pytest.mark.asyncio
async def test_no_hooks_preserves_existing_behavior():
    reply = await _invoke_handler(_ok_handler, json.dumps({"a": 1}), tool_name="t")
    env = json.loads(reply)
    assert env["ok"] is True and env["result"] == {"echo": {"a": 1}}


@pytest.mark.asyncio
async def test_no_hooks_when_session_id_none():
    fired = False

    @pre_tool_use
    def should_not_fire(ctx):
        nonlocal fired
        fired = True
        return None

    reg = HookEngine([should_not_fire])

    reply = await _invoke_handler(
        _ok_handler, json.dumps({"a": 1}), tool_name="t", hooks=reg, session_id=None
    )
    env = json.loads(reply)
    assert env["ok"] is True and env["result"] == {"echo": {"a": 1}}
    assert fired is False


def test_invocation_arriving_in_join_register_window_is_handled() -> None:
    """A tool invocation dispatched the instant the transport connects (the
    join→register window) finds its handler: the engine registers RPC methods
    before ``transport.connect``, and the transport guarantees pre-connect
    registrations are live before any inbound invocation."""
    from .fakes import FakeSessionHarness

    class _InvokeOnConnectTransport(FakeTransport):
        window_reply: str | None = None

        async def connect(self, response: Any, callbacks: Any) -> None:
            await super().connect(response, callbacks)
            # Drain an invocation that "arrived during the join" — delivered
            # before the engine's post-connect code has run.
            method = self.rpc_methods.get("early_tool")
            assert method is not None, "RPC method not registered before connect"
            self.window_reply = await method(
                FakeRpcInvocation(caller_identity=_AGENT_IDENTITY, payload='{"n": 7}')
            )

    async def scenario() -> None:
        seen: dict[str, Any] = {}

        async def handler(args: dict[str, Any]) -> dict[str, Any]:
            seen["args"] = args
            return {"handled": True}

        harness = FakeSessionHarness(_InvokeOnConnectTransport)
        await start_fake_session(harness=harness, tools=[_tool("early_tool", handler)])
        transport = harness.transport
        assert isinstance(transport, _InvokeOnConnectTransport)
        assert transport.window_reply is not None
        envelope = json.loads(transport.window_reply)
        assert envelope["ok"] is True
        assert envelope["result"] == {"handled": True}
        assert seen["args"] == {"n": 7}

    asyncio.run(scenario())
