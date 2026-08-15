"""Long-running client-tool job model.

A client-tool handler written ``async (args, job)`` is long-running: it receives
a :class:`ClientToolJob` to ack the call and deliver its terminal result later.
This module holds that model — the per-invocation :class:`ClientToolJob` and the
session-scoped :class:`ClientToolJobSink` that owns the background tasks and the
reverse-channel publish path. The dispatch that drives them (arity detection, the
ack-vs-inline race) lives in ``_dispatch``.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Awaitable, Callable

import structlog

from cosmo_ai._internal.logging import get_logger
from cosmo_ai._internal.hooks import HookEngine, PostToolUseContext, ToolError, ToolOk, ToolOutcome
from cosmo_ai._internal.protocol import ToolJobResult
from cosmo_ai._internal.rpc import TRUNCATION_SUFFIX

logger: structlog.stdlib.BoundLogger = get_logger(__name__)

# A deferred tool's terminal result rides the reliable data channel, which caps
# ~15 KiB per packet and (unlike the server→client path) is not chunked here. The
# model only ever sees ``summary``/``error``, so an oversized ``result`` is
# replaced with a small marker rather than silently failing the whole publish and
# stranding the call. Text fields are truncated to keep the message deliverable,
# and a final fit pass bounds the *serialized message* — per-field caps alone
# can't, since JSON escaping inflates capped text past the packet budget.
_MAX_TERMINAL_TEXT_CHARS = 2048
_MAX_TERMINAL_RESULT_BYTES = 8 * 1024
_MAX_JOB_MESSAGE_BYTES = 12 * 1024  # the server's per-packet wire budget


def _cap_text(text: str | None) -> str | None:
    if text is not None and len(text) > _MAX_TERMINAL_TEXT_CHARS:
        return text[:_MAX_TERMINAL_TEXT_CHARS] + TRUNCATION_SUFFIX
    return text


def _cap_result(result: dict[str, Any] | None) -> dict[str, Any] | None:
    if result is None:
        return None
    encoded = len(json.dumps(result).encode("utf-8"))
    if encoded <= _MAX_TERMINAL_RESULT_BYTES:
        return result
    logger.warning("realtime.client_tool_job.result_truncated", bytes=encoded)
    return {"_truncated": True, "_original_bytes": encoded}


def _encoded_len(message: ToolJobResult) -> int:
    return len(message.model_dump_json(exclude_none=True).encode("utf-8"))


def _shrink(text: str | None, keep: int) -> str | None:
    if text is None or len(text) <= keep:
        return text
    return text[:keep] + TRUNCATION_SUFFIX


def _fit_for_channel(
    message: ToolJobResult,
) -> ToolJobResult:
    """Shrink an over-budget message until it is deliverable: degrade
    ``result`` to the truncation marker, then halve the text fields."""
    if _encoded_len(message) <= _MAX_JOB_MESSAGE_BYTES:
        return message
    logger.warning(
        "realtime.client_tool_job.message_shrunk_to_fit",
        tool=message.tool_name,
        job_id=message.job_id,
        bytes=_encoded_len(message),
    )
    if message.result is not None:
        message = message.model_copy(update={"result": {"_truncated": True}})
    keep = _MAX_TERMINAL_TEXT_CHARS
    while _encoded_len(message) > _MAX_JOB_MESSAGE_BYTES and keep > 0:
        keep //= 2
        message = message.model_copy(
            update={
                "summary": _shrink(message.summary, keep),
                "error": _shrink(message.error, keep),
            }
        )
    return message


class ClientToolJobSink:
    """Session-scoped owner of long-running client-tool background work.

    Holds the reverse-channel publish path (``tool_job_result`` over the data
    channel) and the set of in-flight handler tasks — strong refs so they are
    not GC'd mid-run, and a ``close()`` that cancels them all on session
    teardown. One instance per session; the runtime constructs it and passes it
    into ``register_client_tool_handlers``.
    """

    def __init__(
        self,
        *,
        publish: Callable[[Any], Awaitable[None]],
        is_open: Callable[[], bool],
    ) -> None:
        self._publish = publish
        self._is_open = is_open
        self._tasks: set[asyncio.Task[Any]] = set()

    def is_open(self) -> bool:
        return self._is_open()

    async def publish(self, message: Any) -> None:
        await self._publish(message)

    def spawn(self, coro: Awaitable[Any]) -> asyncio.Task[Any]:
        task = asyncio.ensure_future(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    def close(self) -> None:
        for task in list(self._tasks):
            task.cancel()


class ClientToolJob:
    """Handle a long-running client tool uses to ack the call, then deliver its
    terminal result later.

    Passed as the second argument to a long-running handler. Call ``ack(note)``
    to release the RPC reply while the handler keeps running, then
    ``complete(result=, summary=)`` or ``fail(error=)`` when the work finishes.
    The terminal methods publish a ``tool_job_result`` message the server injects
    into the live session. All three are idempotent once delivered; a terminal
    call after the session has closed is dropped, and a failed publish raises
    and leaves the job retryable.
    """

    def __init__(
        self,
        *,
        job_id: str,
        tool_name: str,
        sink: ClientToolJobSink,
        hooks: HookEngine | None,
        session_id: str | None,
        arguments: dict[str, Any],
    ) -> None:
        self.job_id = job_id
        self.tool_name = tool_name
        self._sink = sink
        self._hooks = hooks
        self._session_id = session_id
        self._arguments = arguments
        self._ack: asyncio.Future[str] = asyncio.get_running_loop().create_future()
        self._terminal = False

    @property
    def acked(self) -> bool:
        return self._ack.done()

    async def ack(self, note: str = "") -> None:
        """Release the RPC reply as a deferred ack. ``note`` is the model-facing
        text spoken at acceptance (truncated if overlong). Later ``ack`` calls
        are ignored."""
        if self._ack.done():
            logger.warning(
                "realtime.client_tool_job.ack_ignored",
                tool=self.tool_name,
                job_id=self.job_id,
            )
            return
        # Capped so the deferred reply envelope always fits the RPC size cap.
        self._ack.set_result(_cap_text(note) or "")

    async def complete(
        self,
        *,
        result: dict[str, Any] | None = None,
        summary: str | None = None,
    ) -> None:
        """Deliver a successful terminal result. Idempotent once delivered; a
        failed publish raises and leaves the job retryable."""
        await self._deliver(
            status="completed",
            result=result,
            summary=summary,
            error=None,
            outcome=ToolOk(result=result or {}),
        )

    async def fail(self, *, error: str) -> None:
        """Deliver a failed terminal result. Idempotent once delivered; a
        failed publish raises and leaves the job retryable."""
        await self._deliver(
            status="failed",
            result=None,
            summary=None,
            error=error,
            outcome=ToolError(message=error),
        )

    async def _deliver(
        self,
        *,
        status: str,
        result: dict[str, Any] | None,
        summary: str | None,
        error: str | None,
        outcome: ToolOutcome,
    ) -> None:
        if not self._ack.done():
            # Complete/fail without a prior ack still needs the RPC reply to go
            # out deferred, or the worker never registers the job and this result
            # is dropped as unregistered. Ack now (empty note) so it lands.
            logger.warning(
                "realtime.client_tool_job.terminal_before_ack",
                tool=self.tool_name,
                job_id=self.job_id,
            )
            self._ack.set_result("")
        if self._terminal:
            logger.warning(
                "realtime.client_tool_job.terminal_ignored",
                tool=self.tool_name,
                job_id=self.job_id,
            )
            return
        self._terminal = True
        if not self._sink.is_open():
            logger.warning(
                "realtime.client_tool_job.after_close",
                tool=self.tool_name,
                job_id=self.job_id,
            )
            return
        message = _fit_for_channel(
            ToolJobResult(
                job_id=self.job_id,
                tool_name=self.tool_name,
                status=status,  # type: ignore[arg-type]
                result=_cap_result(result),
                summary=_cap_text(summary),
                error=_cap_text(error),
            )
        )
        try:
            await self._sink.publish(message)
        except Exception:
            # A failed publish must not latch the job as delivered: unlatch so
            # the caller can retry, and re-raise so the dropped result is
            # observable instead of silently lost.
            self._terminal = False
            logger.exception(
                "realtime.client_tool_job.publish_failed",
                tool=self.tool_name,
                job_id=self.job_id,
                stack_info=True,
            )
            raise
        if self._hooks is not None and self._session_id is not None:
            await self._hooks.run_post_tool_use(
                PostToolUseContext(
                    tool_name=self.tool_name,
                    arguments=self._arguments,
                    outcome=outcome,
                    session_id=self._session_id,
                )
            )
