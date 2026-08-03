"""Outbound phone call: the agent dials a number and converses with whoever
answers.

The session opens with no participants; ``session.dial`` brings the callee
in as a SIP participant and the agent — already in the room — talks to them.
Unlike the other sends, ``dial`` is an authenticated REST call: the api key
requires phone calls to be enabled for the workspace, and the call counts
against the workspace's weekly per-user minute limit.

No local microphone is involved — the "human" on this call is the phone.

Usage:
    pip install cosmo-ai-sdk
    COSMO_API_KEY=cosmo_... COSMO_DIAL_TO=+14155550199 python examples/outbound_call.py

The SDK targets https://app.askcosmo.ai by default; set COSMO_BASE_URL to point
at another backend for local development.
"""

import asyncio
import os

from cosmo_ai import (
    CosmoRealtime,
    DialError,
    RealtimeError,
    RealtimeReady,
    RealtimeSessionEnded,
    RealtimeTranscriptDelta,
)


async def main() -> None:
    api_key = os.environ.get("COSMO_API_KEY")
    if not api_key:
        raise SystemExit(
            "Set COSMO_API_KEY (outbound calling must be enabled for the workspace)."
        )
    phone_number = os.environ.get("COSMO_DIAL_TO")
    if not phone_number:
        raise SystemExit("Set COSMO_DIAL_TO to an E.164 number, e.g. +14155550199.")

    async with CosmoRealtime(api_key=api_key) as client:
        agent = client.agent(
            instructions=(
                "You are calling on behalf of Acme to confirm an appointment. "
                "Greet the person warmly, confirm the appointment, and answer "
                "any questions briefly."
            ),
        )
        async with agent.start() as session:
            print(f"Session live (id={session.session_id}); dialing {phone_number}…")
            try:
                dial = await session.dial(phone_number)
            except DialError as exc:
                raise SystemExit(f"Dial rejected ({exc.code}): {exc.message}")
            print(f"Dial queued: {dial.dial_id}")

            async for event in session:
                if isinstance(event, RealtimeReady):
                    print(f"[ready] session_id={event.session_id}")
                elif isinstance(event, RealtimeTranscriptDelta):
                    marker = "»" if event.is_final else "…"
                    print(f"  [{event.role.value}] {event.text}{marker}")
                elif isinstance(event, RealtimeError):
                    print(f"  [error] {event.code.value}: {event.message}")
                elif isinstance(event, RealtimeSessionEnded):
                    print(f"  [ended] {event.reason}")


if __name__ == "__main__":
    asyncio.run(main())
