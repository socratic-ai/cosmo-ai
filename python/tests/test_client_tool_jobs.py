"""Long-running (deferred) client tools: arity inference, the ack-vs-inline
reply race, and terminal delivery over the reverse channel.

Driven through ``make_rpc_handler`` with a hand-built ``ClientToolJobSink`` (the
runtime-owned publish + task lifecycle), so the real caller guard, reply race,
and ``job.complete``/``job.fail`` publish paths are exercised without a session.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from cosmo_ai._internal.hooks import (
    HookEngine,
    PostToolUseContext,
    ToolOk,
    post_tool_use,
)
from cosmo_ai.tools._jobs import ClientToolJobSink
from cosmo_ai.tools import BackgroundClientTool, ClientTool, ClientToolJob
from cosmo_ai.tools._dispatch import (
    make_rpc_handler,
    register_client_tool_handlers,
)
from cosmo_ai._internal.rpc import MAX_REPLY_BYTES, TRUNCATION_SUFFIX
from cosmo_ai._internal.transport import RpcMethodError
from cosmo_ai._internal.protocol import ToolJobResult

from .fakes import FakeRpcInvocation, FakeTransport

_AGENT_IDENTITY = "agent-1"
_HUMAN_IDENTITY = "human-1"


def _sink(
    published: list[ToolJobResult], *, open_: bool = True
) -> ClientToolJobSink:
    async def publish(msg: Any) -> None:
        published.append(msg)

    return ClientToolJobSink(publish=publish, is_open=lambda: open_)


def _invoke(handler: Any, sink: ClientToolJobSink, payload: str) -> Any:
    method = make_rpc_handler(
        "export_report", handler, background=True, job_sink=sink
    )
    return method(FakeRpcInvocation(caller_identity=_AGENT_IDENTITY, payload=payload))


def _tool(kind: type, name: str, handler: Any) -> Any:
    return kind(
        name=name, description="d", parameters={"type": "object"}, handler=handler
    )


def test_tool_type_routes_deferred_vs_inline() -> None:
    # The tool CLASS decides the path — a BackgroundClientTool defers, a plain
    # ClientTool runs inline. No handler-arity inference.
    async def scenario() -> None:
        published: list[ToolJobResult] = []
        sink = _sink(published)
        transport = FakeTransport([])

        async def bg(args: dict[str, Any], job: ClientToolJob) -> None:
            await job.ack("bg")
            await job.complete(result={"ok": True})

        async def fast(args: dict[str, Any]) -> dict[str, Any]:
            return {"fast": True}

        register_client_tool_handlers(
            transport,
            [
                _tool(BackgroundClientTool, "bg_tool", bg),
                _tool(ClientTool, "fast_tool", fast),
            ],
            job_sink=sink,
        )
        def inv() -> FakeRpcInvocation:
            return FakeRpcInvocation(caller_identity=_AGENT_IDENTITY, payload="{}")

        bg_reply = json.loads(await transport.rpc_methods["bg_tool"](inv()))
        assert bg_reply["deferred"] is True

        fast_reply = json.loads(await transport.rpc_methods["fast_tool"](inv()))
        assert "deferred" not in fast_reply and fast_reply["result"] == {"fast": True}

    asyncio.run(scenario())


def test_ack_yields_deferred_reply_and_completes() -> None:
    async def scenario() -> None:
        published: list[ToolJobResult] = []
        sink = _sink(published)

        async def export(args: dict[str, Any], job: ClientToolJob) -> None:
            await job.ack("starting export")
            await asyncio.sleep(0)
            await job.complete(result={"url": "https://x"}, summary="ready")

        reply = json.loads(await _invoke(export, sink, json.dumps({})))
        assert reply["ok"] is True
        assert reply["deferred"] is True
        assert reply["result"] == {"note": "starting export"}
        job_id = reply["job_id"]

        # The background task delivers the terminal result over the sink.
        await asyncio.gather(*list(sink._tasks))
        assert len(published) == 1
        msg = published[0]
        assert isinstance(msg, ToolJobResult)
        assert msg.type == "tool_job_result"
        assert msg.job_id == job_id
        assert msg.tool_name == "export_report"
        assert msg.status == "completed"
        assert msg.summary == "ready"
        assert msg.result == {"url": "https://x"}

    asyncio.run(scenario())


def test_oversized_ack_note_is_truncated_so_the_deferred_reply_fits() -> None:
    async def scenario() -> None:
        sink = _sink([])

        async def export(args: dict[str, Any], job: ClientToolJob) -> None:
            await job.ack("é" * 16 * 1024)
            await job.complete(result={})

        raw = await _invoke(export, sink, json.dumps({}))
        assert len(raw.encode("utf-8")) <= MAX_REPLY_BYTES
        reply = json.loads(raw)
        assert reply["ok"] is True
        assert reply["deferred"] is True
        assert reply["result"]["note"].endswith(TRUNCATION_SUFFIX)
        await asyncio.gather(*list(sink._tasks))

    asyncio.run(scenario())


def test_background_handler_that_finishes_without_acking_errors() -> None:
    # A background tool must ack + complete/fail; returning without acking is a
    # misuse and surfaces a clean error (not an inline result).
    async def scenario() -> None:
        published: list[ToolJobResult] = []
        sink = _sink(published)

        async def noop(args: dict[str, Any], job: ClientToolJob) -> None:
            return None  # never acks or completes

        reply = json.loads(await _invoke(noop, sink, json.dumps({})))
        assert reply["ok"] is False
        assert "without acking" in reply["error"]
        assert published == []

    asyncio.run(scenario())


def test_raise_after_ack_auto_fails() -> None:
    async def scenario() -> None:
        published: list[ToolJobResult] = []
        sink = _sink(published)

        async def boom(args: dict[str, Any], job: ClientToolJob) -> None:
            await job.ack("working")
            raise RuntimeError("kaboom")

        reply = json.loads(await _invoke(boom, sink, json.dumps({})))
        assert reply["deferred"] is True

        await asyncio.gather(*list(sink._tasks))
        assert len(published) == 1
        assert published[0].status == "failed"
        assert "kaboom" in (published[0].error or "")

    asyncio.run(scenario())


def test_raise_before_ack_is_inline_error() -> None:
    async def scenario() -> None:
        published: list[ToolJobResult] = []
        sink = _sink(published)

        async def early(args: dict[str, Any], job: ClientToolJob) -> None:
            raise ValueError("bad args")

        reply = json.loads(await _invoke(early, sink, json.dumps({})))
        assert reply["ok"] is False
        assert "deferred" not in reply
        assert "bad args" in reply["error"]
        assert published == []

    asyncio.run(scenario())


def test_double_complete_is_idempotent() -> None:
    async def scenario() -> None:
        published: list[ToolJobResult] = []
        sink = _sink(published)

        async def twice(args: dict[str, Any], job: ClientToolJob) -> None:
            await job.ack()
            await job.complete(result={"n": 1})
            await job.complete(result={"n": 2})  # ignored

        await _invoke(twice, sink, json.dumps({}))
        await asyncio.gather(*list(sink._tasks))
        assert len(published) == 1
        assert published[0].result == {"n": 1}

    asyncio.run(scenario())


def test_complete_after_session_close_is_dropped() -> None:
    async def scenario() -> None:
        published: list[ToolJobResult] = []
        sink = _sink(published, open_=False)  # session already gone

        async def export(args: dict[str, Any], job: ClientToolJob) -> None:
            await job.ack()
            await job.complete(result={"url": "x"})

        await _invoke(export, sink, json.dumps({}))
        await asyncio.gather(*list(sink._tasks))
        assert published == []  # nothing to deliver to a closed session

    asyncio.run(scenario())


def test_sink_close_cancels_in_flight_task() -> None:
    async def scenario() -> None:
        published: list[ToolJobResult] = []
        sink = _sink(published)
        started = asyncio.Event()

        async def slow(args: dict[str, Any], job: ClientToolJob) -> None:
            await job.ack()
            started.set()
            await asyncio.sleep(3600)  # would outlive the session
            await job.complete(result={"never": True})

        await _invoke(slow, sink, json.dumps({}))
        await started.wait()
        tasks = list(sink._tasks)
        assert len(tasks) == 1

        sink.close()
        await asyncio.gather(*tasks, return_exceptions=True)
        assert tasks[0].cancelled()
        assert published == []

    asyncio.run(scenario())


def test_caller_guard_rejects_non_agent_for_long_running() -> None:
    async def scenario() -> None:
        published: list[ToolJobResult] = []
        sink = _sink(published)

        async def export(args: dict[str, Any], job: ClientToolJob) -> None:
            await job.ack()

        method = make_rpc_handler(
            "export_report", export, background=True, job_sink=sink
        )
        with pytest.raises(RpcMethodError):
            await method(
                FakeRpcInvocation(
                    caller_identity=_HUMAN_IDENTITY, payload="{}", caller_is_agent=False
                )
            )
        assert published == []

    asyncio.run(scenario())


def test_long_running_handler_without_sink_errors() -> None:
    async def scenario() -> None:
        async def export(args: dict[str, Any], job: ClientToolJob) -> None:
            await job.ack()

        method = make_rpc_handler("export_report", export, background=True, job_sink=None
        )
        reply = json.loads(
            await method(
                FakeRpcInvocation(caller_identity=_AGENT_IDENTITY, payload="{}")
            )
        )
        assert reply["ok"] is False
        assert "job sink" in reply["error"]

    asyncio.run(scenario())


def test_oversized_result_truncated_but_summary_preserved() -> None:
    # A large result must not fail the whole publish — the model-facing summary
    # still has to reach the server, so an oversized result is replaced.
    async def scenario() -> None:
        published: list[ToolJobResult] = []
        sink = _sink(published)

        async def export(args: dict[str, Any], job: ClientToolJob) -> None:
            await job.ack()
            await job.complete(result={"blob": "x" * 20000}, summary="ready")

        await _invoke(export, sink, json.dumps({}))
        await asyncio.gather(*list(sink._tasks))
        assert len(published) == 1
        msg = published[0]
        assert msg.summary == "ready"
        assert msg.result is not None and msg.result.get("_truncated") is True
        assert msg.result["_original_bytes"] > 8 * 1024

    asyncio.run(scenario())


def test_task_cancelled_before_ack_returns_error_not_raise() -> None:
    # Session teardown cancels the handler while it is still pre-ack; the RPC
    # method must return a clean error, not let CancelledError escape.
    async def scenario() -> None:
        published: list[ToolJobResult] = []
        sink = _sink(published)
        entered = asyncio.Event()

        async def slow(args: dict[str, Any], job: ClientToolJob) -> None:
            entered.set()
            await asyncio.sleep(3600)  # suspends BEFORE acking
            await job.ack()

        method = make_rpc_handler("export_report", slow, background=True, job_sink=sink
        )
        invoke = asyncio.ensure_future(
            method(FakeRpcInvocation(caller_identity=_AGENT_IDENTITY, payload="{}"))
        )
        await entered.wait()
        await asyncio.sleep(0)  # let _invoke reach asyncio.wait
        sink.close()  # cancels the pre-ack handler task
        reply = json.loads(await invoke)
        assert reply["ok"] is False
        assert "cancelled" in reply["error"]
        assert published == []

    asyncio.run(scenario())


def test_complete_without_ack_auto_acks_and_delivers() -> None:
    # A handler that completes without acking still gets a deferred reply (so the
    # worker registers the job) and delivers its result.
    async def scenario() -> None:
        published: list[ToolJobResult] = []
        sink = _sink(published)

        async def export(args: dict[str, Any], job: ClientToolJob) -> None:
            await job.complete(result={"url": "x"}, summary="done")  # no ack()

        reply = json.loads(await _invoke(export, sink, json.dumps({})))
        assert reply["deferred"] is True
        await asyncio.gather(*list(sink._tasks))
        assert len(published) == 1 and published[0].summary == "done"

    asyncio.run(scenario())


def test_return_after_ack_without_terminal_auto_fails() -> None:
    # Returning after acking without complete/fail abandons a job the server is
    # waiting on: the SDK settles it as a failure (a bare return value is still
    # ignored — job.complete is the only success path) and PostToolUse fires.
    async def scenario() -> None:
        published: list[ToolJobResult] = []
        sink = _sink(published)

        outcomes: list[Any] = []

        @post_tool_use
        def observe(ctx: PostToolUseContext) -> None:
            outcomes.append(ctx.outcome)

        hooks = HookEngine([observe])

        async def export(args: dict[str, Any], job: ClientToolJob) -> dict[str, Any]:
            await job.ack("working")
            return {"leaked": True}

        method = make_rpc_handler(
            "export_report",
            export,  # type: ignore[arg-type]  # misuse under test: returns a value
            background=True,
            job_sink=sink,
            hooks=hooks,
            session_id="sess-1",
        )
        reply = json.loads(
            await method(
                FakeRpcInvocation(caller_identity=_AGENT_IDENTITY, payload="{}")
            )
        )
        assert reply["deferred"] is True
        await asyncio.gather(*list(sink._tasks))
        assert len(published) == 1
        assert published[0].status == "failed"
        assert "without completing" in (published[0].error or "")
        assert published[0].result is None
        assert len(outcomes) == 1
        assert not isinstance(outcomes[0], ToolOk)

    asyncio.run(scenario())


def test_terminal_message_is_shrunk_to_fit_the_packet_budget() -> None:
    # Per-field caps alone can't bound the serialized message: capped text made
    # of JSON-escaping-heavy characters plus a max-size result overflows the
    # packet budget. The final fit pass degrades the result to the marker.
    async def scenario() -> None:
        published: list[ToolJobResult] = []
        sink = _sink(published)
        heavy = '"' * 4000  # each escapes to two bytes; capped to 2048 chars
        big_result = {"blob": "x" * 8150}  # under the 8 KiB result cap

        async def export(args: dict[str, Any], job: ClientToolJob) -> None:
            await job.ack()
            await job.complete(result=big_result, summary=heavy)

        await _invoke(export, sink, json.dumps({}))
        await asyncio.gather(*list(sink._tasks))
        assert len(published) == 1
        msg = published[0]
        encoded = len(msg.model_dump_json(exclude_none=True).encode("utf-8"))
        assert encoded <= 12 * 1024
        assert msg.result == {"_truncated": True}
        assert msg.summary is not None and msg.summary.endswith("[truncated]")

    asyncio.run(scenario())


def test_overlong_ack_note_is_truncated_to_fit_the_reply_cap() -> None:
    async def scenario() -> None:
        published: list[ToolJobResult] = []
        sink = _sink(published)
        huge = "n" * 100_000

        async def export(args: dict[str, Any], job: ClientToolJob) -> None:
            await job.ack(huge)
            await job.complete(result={})

        raw = await _invoke(export, sink, json.dumps({}))
        assert len(raw.encode("utf-8")) <= MAX_REPLY_BYTES
        reply = json.loads(raw)
        assert reply["deferred"] is True
        note = reply["result"]["note"]
        assert note.endswith("[truncated]")
        assert len(note) < len(huge)
        await asyncio.gather(*list(sink._tasks))

    asyncio.run(scenario())


def test_failed_publish_leaves_job_retryable_and_defers_post_hook() -> None:
    # Mirrors the TS pin: a failed terminal publish raises, unlatches the job
    # so the caller can retry, and PostToolUse fires only for the delivered
    # terminal — never for the dropped one.
    async def scenario() -> None:
        published: list[ToolJobResult] = []
        fail_next = True

        async def publish(msg: Any) -> None:
            nonlocal fail_next
            if fail_next:
                fail_next = False
                raise RuntimeError("data channel closed")
            published.append(msg)

        sink = ClientToolJobSink(publish=publish, is_open=lambda: True)

        outcomes: list[Any] = []

        @post_tool_use
        def observe(ctx: PostToolUseContext) -> None:
            outcomes.append(ctx.outcome)

        hooks = HookEngine([observe])

        first_error: list[Exception] = []

        async def export(args: dict[str, Any], job: ClientToolJob) -> None:
            await job.ack()
            try:
                await job.complete(summary="first try")
            except Exception as exc:
                first_error.append(exc)
            await job.complete(summary="second try")

        method = make_rpc_handler(
            "export_report",
            export,
            background=True,
            job_sink=sink,
            hooks=hooks,
            session_id="sess-1",
        )
        reply = json.loads(
            await method(
                FakeRpcInvocation(caller_identity=_AGENT_IDENTITY, payload="{}")
            )
        )
        assert reply["deferred"] is True
        await asyncio.gather(*list(sink._tasks))

        assert len(first_error) == 1
        assert str(first_error[0]) == "data channel closed"
        assert len(published) == 1
        assert published[0].summary == "second try"
        assert outcomes == [ToolOk(result={})]

    asyncio.run(scenario())
