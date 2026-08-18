"""Production guardrails, runnable: the hook patterns from the
"Add production guardrails" guide composed into one text-only session.

* ``scrub_pii`` (PreToolUse) rewrites arguments so emails and phone numbers
  never reach the handler — or anything the handler forwards to.
* ``audit_trail`` (PostToolUse) appends one JSON line per client-tool outcome
  to ``tool_audit.jsonl``, denials and errors included. Server tools report
  through the event stream instead — a complete trail combines both.
* ``wrap_up_call`` is a client tool whose handler raises while the call's
  goal (a filed case note) is unmet — the error text steers the model back
  to work instead of hanging up.
* ``escalate_incomplete`` (SessionEnd) is the safety net: it runs on every
  exit path and queues follow-up if the session ended before the goal.

No microphone or speaker required — this example uses the text channel only.
The agent still speaks into the room; nothing here plays it. Configure the
agent with audio=AudioConfig(output=False) for a genuinely silent session.

Usage:
    pip install cosmo-ai-sdk cosmo-cli
    python examples/python/production_hooks.py   # after `cosmo login`, or with COSMO_API_KEY set

The SDK targets https://platform.askcosmo.ai by default; set COSMO_BASE_URL to point
at another backend for local development.
"""

import asyncio
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from cosmo_ai import (
    RealtimeClient,
    SessionEndedEvent,
    ToolCallEvent,
    ToolResultEvent,
    TranscriptDeltaEvent,
    hooks,
    tool,
)
from cosmo_ai.hooks import PostToolUseContext, PreToolUseContext, PreToolUseResult, SessionEndContext

AUDIT_LOG = Path("tool_audit.jsonl")

# Deliberately simple patterns for the demo; production redaction should use a
# dedicated library (e.g. `phonenumbers`) to handle international formats
# without false positives.
EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
PHONE_RE = re.compile(r"(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}")


def redact_pii(text: str) -> str:
    return PHONE_RE.sub("[phone]", EMAIL_RE.sub("[email]", text))


class CaseNoteInput(BaseModel):
    note: str = Field(description="Free-text note to file on the customer's case")


class WrapUpInput(BaseModel):
    outcome: str = Field(description="What was accomplished on this call")


# Single-session demo state; key this per session id in real use.
case_notes: list[str] = []


@tool
async def log_case_note(input: CaseNoteInput) -> dict[str, Any]:
    """File a note on the customer's case in the CRM."""
    # Stands in for a real CRM call — by the time this runs, scrub_pii has
    # already rewritten input.note.
    case_notes.append(input.note)
    return {"filed": True, "note": input.note}


@tool
async def wrap_up_call(input: WrapUpInput) -> dict[str, str]:
    """Confirm the call's goals are met. Call this before ending the call."""
    if not case_notes:
        raise RuntimeError(
            "Not done yet: no case note has been filed. File one with "
            "log_case_note, or offer to connect the caller with a person."
        )
    return {"status": "complete", "outcome": input.outcome}


@hooks.pre_tool_use(matcher="log_case_note")
def scrub_pii(ctx: PreToolUseContext) -> PreToolUseResult:
    note = ctx.arguments.get("note")
    if not isinstance(note, str):
        return PreToolUseResult()
    return PreToolUseResult(updated_arguments={**ctx.arguments, "note": redact_pii(note)})


@hooks.post_tool_use
def audit_trail(ctx: PostToolUseContext) -> None:
    # The rewrite hook only covers log_case_note; redact again at the sink so
    # PII the model echoes into any other tool's arguments stays out of the log.
    record = {
        "at": datetime.now(timezone.utc).isoformat(),
        "session_id": ctx.session_id,
        "tool": ctx.tool_name,
        "arguments": {
            k: redact_pii(v) if isinstance(v, str) else v
            for k, v in ctx.arguments.items()
        },
        "outcome": type(ctx.outcome).__name__,
    }
    with AUDIT_LOG.open("a") as f:
        f.write(json.dumps(record) + "\n")


@hooks.session_end
def escalate_incomplete(ctx: SessionEndContext) -> None:
    if not case_notes:
        print(f"[follow-up queued] session={ctx.session_id} reason={ctx.reason.value}")


async def main() -> None:
    async with RealtimeClient() as client:
        agent = client.agent(
            instructions=(
                "You are a support agent for Acme. Before ending a call, file a "
                "case note with log_case_note, then confirm with wrap_up_call."
            ),
            tools=[log_case_note, wrap_up_call],
            hooks=[scrub_pii, audit_trail, escalate_incomplete],
        )
        async with agent.start() as session:
            print(f"Connected — session_id={session.session_id}")

            async def drive() -> None:
                await asyncio.sleep(2)
                # First turn tries to end with nothing documented — wrap_up_call
                # raises and the model recovers.
                await session.send_text("I'm all set, you can end the call now.")
                await asyncio.sleep(10)
                # Second turn carries PII — scrub_pii strips it before the
                # note reaches the handler or the audit trail.
                await session.send_text(
                    "Actually, please note on my case that my new email is "
                    "jane@example.com and my number is +1 415 555 0175, "
                    "then wrap up the call."
                )
                await asyncio.sleep(15)
                await session.end()

            driver = asyncio.create_task(drive())

            async for event in session:
                if isinstance(event, TranscriptDeltaEvent) and event.is_final:
                    print(f"[transcript:{event.role.value}] {event.text}")
                elif isinstance(event, ToolCallEvent):
                    print(f"[tool_call] {event.name}")
                elif isinstance(event, ToolResultEvent):
                    status = "ok" if event.ok else "err"
                    print(f"[tool_result:{status}] {event.summary}")
                elif isinstance(event, SessionEndedEvent):
                    print(f"[session-ended] {event.reason}")

            await driver

    print(f"Filed notes (post-redaction): {case_notes}")
    records = len(AUDIT_LOG.read_text().splitlines()) if AUDIT_LOG.exists() else 0
    print(f"Audit trail: {AUDIT_LOG} ({records} records)")


if __name__ == "__main__":
    asyncio.run(main())
