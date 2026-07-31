"""Hooks example: deny a destructive tool and log every tool outcome.

Run against a backend:
    COSMO_API_KEY=cosmo_... python examples/hooks_agent.py

The SDK targets https://app.askcosmo.ai by default; set COSMO_BASE_URL to point
at another backend for local development.
"""

from __future__ import annotations

import asyncio
import os

import structlog

from cosmo_ai import CosmoRealtime, hooks
from cosmo_ai.hooks import (
    PostToolUseContext,
    PreToolUseContext,
    PreToolUseResult,
    SessionStartContext,
    SessionStartResult,
    SessionEndContext,
)

logger = structlog.get_logger(__name__)


@hooks.session_start
def add_context(ctx: SessionStartContext) -> SessionStartResult:
    return SessionStartResult(additional_context="Be concise and warm.")


@hooks.pre_tool_use(matcher="delete_*")
def block_deletes(ctx: PreToolUseContext) -> PreToolUseResult:
    return PreToolUseResult(permission="deny", reason="destructive tools are disabled")


@hooks.post_tool_use
def log_outcome(ctx: PostToolUseContext) -> None:
    logger.info("tool.done", tool=ctx.tool_name, outcome=type(ctx.outcome).__name__)


@hooks.session_end
def on_session_end(ctx: SessionEndContext) -> None:
    logger.info("session.stopped", reason=ctx.reason.value)


async def main() -> None:
    api_key = os.environ.get("COSMO_API_KEY")
    if not api_key:
        raise SystemExit("Set COSMO_API_KEY to run this example (e.g. COSMO_API_KEY=cosmo_...).")

    client = CosmoRealtime(api_key=api_key)
    agent = client.agent(
        instructions="You are Alex.",
        hooks=[add_context, block_deletes, log_outcome, on_session_end],
    )
    async with agent.start() as session:
        async for event in session:
            logger.info("event", type=type(event).__name__)


if __name__ == "__main__":
    asyncio.run(main())
