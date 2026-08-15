"""Client-tool handler dispatch over the transport's RPC surface.

The public surface (:class:`~cosmo_ai._internal.protocol.ClientTool` with an async
``handler``) carries no transport vocabulary. This module adapts each handler
into an RPC method — registered via :meth:`Transport.register_rpc_method` and
invoked with a vendor-free :class:`RpcInvocation` — whose request payload is
``json.dumps(args)`` and whose reply is the JSON envelope ``{"ok", "result",
"error"}``. The agent-only caller guard reads ``invocation.caller_is_agent``
(the transport resolves the participant kind).

A :class:`~cosmo_ai._internal.protocol.ClientTool` runs inline (``async (args) ->
result``). A :class:`~cosmo_ai._internal.protocol.BackgroundClientTool` runs on the
deferred path: its handler (``async (args, job) -> None``) receives a
:class:`ClientToolJob`, calls ``job.ack(note)`` to release the RPC reply early (a
``deferred`` envelope) and keeps running; when the work finishes it calls
``job.complete(...)`` / ``job.fail(...)``, which publishes a ``tool_job_result``
message the server injects into the live session. The SDK owns the task running
the handler — strong ref, cancelled on session close, auto-``fail`` on a
post-ack raise or a post-ack return with no terminal result.

Only the session's agent participant may invoke a client tool; an invocation
from any non-agent caller is rejected so LiveKit surfaces an error to the
caller rather than running the handler.
"""

from __future__ import annotations

import asyncio
import uuid
from typing import Any

import structlog

from cosmo_ai._internal.logging import get_logger
from cosmo_ai._internal.rpc import (
    decode_args,
    deferred_reply,
    ensure_agent_caller,
    error_reply,
    success_reply,
)
from cosmo_ai._internal.transport import RpcHandler, RpcInvocation, Transport
from cosmo_ai.errors import ToolInputValidationError
from cosmo_ai._internal.hooks import (
    HookEngine,
    PostToolUseContext,
    ToolDenied,
    ToolError,
    ToolOk,
    ToolOutcome,
)
from cosmo_ai._internal.protocol import (
    BackgroundClientTool,
    BackgroundClientToolHandler,
    ClientTool,
    ClientToolHandler,
)
from cosmo_ai.tools._jobs import ClientToolJob, ClientToolJobSink

logger: structlog.stdlib.BoundLogger = get_logger(__name__)


def _envelope_result(result: dict[str, Any] | None) -> tuple[str, ToolOutcome]:
    """Build the success envelope for a handler result, shortening it to fit
    the payload ceiling when it has to. The outcome carries the handler's own
    result, not the shortened one — the cap is a transport property, not a tool
    failure."""
    envelope, truncated = success_reply(result)
    if truncated:
        logger.warning("realtime.client_tool_result_truncated")
    return envelope, ToolOk(result=result)


async def _apply_pre_hook(
    hooks: HookEngine | None,
    session_id: str | None,
    *,
    tool_name: str,
    args: dict[str, Any],
) -> tuple[dict[str, Any] | None, str | None]:
    """Run PreToolUse. Returns ``(args, None)`` to proceed with possibly
    rewritten args, or ``(None, reply)`` when the hook denied the call."""
    if hooks is None or session_id is None:
        return args, None
    decision = await hooks.run_pre_tool_use(
        tool_name=tool_name, arguments=args, session_id=session_id
    )
    if decision.denied:
        reply = error_reply(decision.reason or "denied by hook")
        await hooks.run_post_tool_use(
            PostToolUseContext(
                tool_name=tool_name,
                arguments=decision.arguments,
                outcome=ToolDenied(reason=decision.reason or "denied by hook"),
                session_id=session_id,
            )
        )
        return None, reply
    return decision.arguments, None


async def _invoke_handler(
    handler: ClientToolHandler,
    payload: str,
    *,
    tool_name: str,
    hooks: HookEngine | None = None,
    session_id: str | None = None,
) -> str:
    """Decode the RPC request, run PreToolUse hooks, run a plain handler, build
    the reply envelope, then fire PostToolUse with the final outcome."""
    decoded = decode_args(payload)
    if isinstance(decoded, str):
        return error_reply(decoded)

    resolved_args, denied_reply = await _apply_pre_hook(
        hooks, session_id, tool_name=tool_name, args=decoded
    )
    if denied_reply is not None:
        return denied_reply
    assert resolved_args is not None

    reply, outcome = await _run_and_envelope(
        handler,
        resolved_args,
        tool_name=tool_name,
        args_rewritten=resolved_args != decoded,
    )

    if hooks is not None and session_id is not None:
        await hooks.run_post_tool_use(
            PostToolUseContext(
                tool_name=tool_name,
                arguments=resolved_args,
                outcome=outcome,
                session_id=session_id,
            )
        )
    return reply


async def _run_and_envelope(
    handler: ClientToolHandler,
    args: dict[str, Any],
    *,
    tool_name: str,
    args_rewritten: bool,
) -> tuple[str, ToolOutcome]:
    """Run a plain handler and return the (reply envelope, final ToolOutcome). A
    handler exception or an oversized success both map to an error reply — the
    outcome always matches the envelope the model receives."""
    try:
        result = await handler(args)
    except Exception as exc:
        logger.exception("realtime.client_tool_handler_failed", stack_info=True)
        _warn_if_hook_rewrite_broke_validation(exc, tool_name, args_rewritten)
        message = str(exc) or exc.__class__.__name__
        return error_reply(message), ToolError(message=message)
    return _envelope_result(result)


def _warn_if_hook_rewrite_broke_validation(
    exc: Exception, tool_name: str, args_rewritten: bool
) -> None:
    """A PreToolUse hook can rewrite valid model args into invalid handler
    args; the resulting INVALID_INPUT envelope would wrongly tell the model to
    retry. Only this layer knows a rewrite happened, so surface it as a
    structured event for the developer (the envelope is unchanged)."""
    if args_rewritten and isinstance(exc, ToolInputValidationError):
        logger.warning(
            "realtime.client_tool_validation_failed_after_hook_rewrite",
            tool=tool_name,
        )


async def _invoke_deferred_handler(
    handler: BackgroundClientToolHandler,
    payload: str,
    *,
    tool_name: str,
    sink: ClientToolJobSink,
    hooks: HookEngine | None = None,
    session_id: str | None = None,
) -> str:
    """Drive a background handler: decode, PreToolUse, then run it on a
    sink-owned task and race two outcomes — the handler calling ``job.ack``
    (deferred reply, task kept alive) versus the handler finishing/raising
    before it acks (an error reply now). PostToolUse fires at the terminal
    signal for a deferred call, or here for a pre-ack failure."""
    decoded = decode_args(payload)
    if isinstance(decoded, str):
        return error_reply(decoded)

    resolved_args, denied_reply = await _apply_pre_hook(
        hooks, session_id, tool_name=tool_name, args=decoded
    )
    if denied_reply is not None:
        return denied_reply
    assert resolved_args is not None

    job = ClientToolJob(
        job_id=uuid.uuid4().hex,
        tool_name=tool_name,
        sink=sink,
        hooks=hooks,
        session_id=session_id,
        arguments=resolved_args,
    )
    task = sink.spawn(_run_deferred(handler, resolved_args, job, tool_name=tool_name))

    await asyncio.wait({job._ack, task}, return_when=asyncio.FIRST_COMPLETED)

    if job.acked:
        # Deferred: the task keeps running (the sink owns it); the terminal
        # result and PostToolUse arrive later via job.complete / job.fail.
        note = job._ack.result()
        logger.info(
            "realtime.client_tool_deferred", tool=tool_name, job_id=job.job_id
        )
        return deferred_reply(job_id=job.job_id, note=note)

    # Not acked → the task finished before releasing a deferred reply.
    if task.cancelled():
        # Session teardown cancelled the handler before it acked; there is no
        # reply to build. Surface a clean error rather than letting the
        # CancelledError (a BaseException) escape the RPC method.
        return error_reply("client tool handler was cancelled")
    try:
        task.result()  # re-raise a pre-ack exception, if any
    except Exception as exc:
        _warn_if_hook_rewrite_broke_validation(
            exc, tool_name, resolved_args != decoded
        )
        message = str(exc) or exc.__class__.__name__
        await _fire_post_hook(
            hooks, session_id, tool_name, resolved_args, ToolError(message=message)
        )
        return error_reply(message)

    # The handler returned without ever acking or completing — a misuse of a
    # background tool (it should call job.ack then job.complete / job.fail).
    logger.warning("realtime.client_tool_job.finished_without_ack", tool=tool_name)
    message = "background client tool returned without acking or completing"
    await _fire_post_hook(
        hooks, session_id, tool_name, resolved_args, ToolError(message=message)
    )
    return error_reply(message)


async def _run_deferred(
    handler: BackgroundClientToolHandler,
    args: dict[str, Any],
    job: ClientToolJob,
    *,
    tool_name: str,
) -> None:
    """Run a background handler. A raise after ``ack`` is turned into
    ``job.fail`` (the deferred reply already went out); a raise before ``ack``
    propagates so the caller can build an inline error reply. A clean return
    after ``ack`` with no terminal result is settled as a failure — the server
    is waiting on a ``tool_job_result`` that would otherwise never come."""
    try:
        await handler(args, job)
    except Exception as exc:
        message = str(exc) or exc.__class__.__name__
        if job.acked:
            logger.exception(
                "realtime.client_tool_job.handler_failed_after_ack",
                tool=tool_name,
                stack_info=True,
            )
            try:
                await job.fail(error=message)
            except Exception:
                # Sink-owned tasks are settle-only: an undeliverable failure
                # result is logged, never raised into the tracked task.
                logger.exception(
                    "realtime.client_tool_job.failure_undeliverable",
                    tool=tool_name,
                    stack_info=True,
                )
            return
        logger.exception(
            "realtime.client_tool_handler_failed", tool=tool_name, stack_info=True
        )
        raise
    if job.acked and not job._terminal:
        logger.warning(
            "realtime.client_tool_job.abandoned",
            tool=tool_name,
            job_id=job.job_id,
        )
        try:
            await job.fail(
                error="background client tool returned without completing"
            )
        except Exception:
            logger.exception(
                "realtime.client_tool_job.failure_undeliverable",
                tool=tool_name,
                stack_info=True,
            )


async def _fire_post_hook(
    hooks: HookEngine | None,
    session_id: str | None,
    tool_name: str,
    args: dict[str, Any],
    outcome: ToolOutcome,
) -> None:
    if hooks is None or session_id is None:
        return
    await hooks.run_post_tool_use(
        PostToolUseContext(
            tool_name=tool_name,
            arguments=args,
            outcome=outcome,
            session_id=session_id,
        )
    )


def make_rpc_handler(
    tool_name: str,
    handler: ClientToolHandler | BackgroundClientToolHandler,
    *,
    background: bool = False,
    hooks: HookEngine | None = None,
    session_id: str | None = None,
    job_sink: ClientToolJobSink | None = None,
) -> RpcHandler:
    """Build the RPC method for one client tool: caller-guard, then decode →
    run → envelope. A ``background`` tool (a :class:`BackgroundClientTool`) is
    driven through the deferred path when a ``job_sink`` is available. Returns an
    async ``(RpcInvocation) -> str`` for :meth:`Transport.register_rpc_method`."""

    async def rpc_method(invocation: RpcInvocation) -> str:
        ensure_agent_caller(invocation, method_name=tool_name)
        if background:
            if job_sink is None:
                logger.error(
                    "realtime.client_tool_no_job_sink",
                    tool=tool_name,
                )
                return error_reply(
                    "background client tool has no session job sink"
                )
            return await _invoke_deferred_handler(
                handler,  # type: ignore[arg-type]
                invocation.payload,
                tool_name=tool_name,
                sink=job_sink,
                hooks=hooks,
                session_id=session_id,
            )
        return await _invoke_handler(
            handler,  # type: ignore[arg-type]
            invocation.payload,
            tool_name=tool_name,
            hooks=hooks,
            session_id=session_id,
        )

    return rpc_method


def register_client_tool_handlers(
    transport: Transport,
    tools: list[ClientTool],
    *,
    hooks: HookEngine | None = None,
    session_id: str | None = None,
    job_sink: ClientToolJobSink | None = None,
) -> None:
    """Register one RPC method per client tool.

    A :class:`BackgroundClientTool` is registered on the deferred path (driven
    through ``job_sink``); a plain :class:`ClientTool` runs inline.
    """
    for tool in tools:
        background = isinstance(tool, BackgroundClientTool)
        transport.register_rpc_method(
            tool.name,
            make_rpc_handler(
                tool.name,
                tool.handler,
                background=background,
                hooks=hooks,
                session_id=session_id,
                job_sink=job_sink,
            ),
        )
        logger.info(
            "realtime.client_tool_registered",
            tool=tool.name,
            background=background,
        )
