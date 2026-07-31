"""Cosmo voice CLI — minimal two-way voice demo of cosmo-ai-sdk.

Enables the default OS microphone and speaker (``set_microphone_enabled`` /
``set_speaker_enabled``), prints live transcripts to stdout, and exits cleanly
on Ctrl-C or when the user types a blank line. OS audio I/O needs the
``[audio]`` extra, which already includes ``[livekit]``.

Usage:
    pip install -e .
    cosmo-voice --api-key cosmo_...

    # or via python -m
    python -m cosmo_voice_cli --api-key cosmo_...

The SDK targets https://app.askcosmo.ai by default; set COSMO_BASE_URL to point
at another backend for local development.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys

from cosmo_ai import (
    CosmoRealtime,
    RealtimeError,
    RealtimeReady,
    RealtimeSession,
    RealtimeSessionEnded,
    RealtimeToolCall,
    RealtimeTranscriptDelta,
)


async def _print_events(session: RealtimeSession) -> None:
    async for event in session:
        if isinstance(event, RealtimeReady):
            print(
                f"[ready] session_id={session.session_id}",
                flush=True,
            )
            print(
                "Speak into your microphone — the agent replies out loud. "
                "Press Enter (blank line) to end.",
                flush=True,
            )
        elif isinstance(event, RealtimeTranscriptDelta):
            marker = "»" if event.is_final else "…"
            print(f"  [{event.role.value}] {event.text}{marker}", flush=True)
        elif isinstance(event, RealtimeToolCall):
            print(f"  [tool] {event.name} (id={event.tool_call_id})", flush=True)
        elif isinstance(event, RealtimeError):
            print(
                f"  [error] {event.code.value}: {event.message}",
                file=sys.stderr,
                flush=True,
            )
        elif isinstance(event, RealtimeSessionEnded):
            print(f"  [ended] {event.reason}", flush=True)


async def run(api_key: str, voice: str | None, model: str | None) -> None:
    async with CosmoRealtime(api_key=api_key) as client:
        print("Connecting…", flush=True)
        agent = client.agent(voice=voice, model=model)
        async with agent.start() as session:
            print(f"Joined room: {session.response.room_name}", flush=True)

            printer = asyncio.create_task(_print_events(session))

            print("Enabling microphone…", flush=True)
            await session.set_microphone_enabled(True)

            print("Enabling speaker…", flush=True)
            await session.set_speaker_enabled(True)

            loop = asyncio.get_event_loop()
            try:
                await loop.run_in_executor(None, sys.stdin.readline)
            except (KeyboardInterrupt, EOFError):
                pass

            print("Ending session…", flush=True)
            await session.end()
            await printer


def main() -> None:
    parser = argparse.ArgumentParser(description="Cosmo voice CLI demo")
    parser.add_argument(
        "--api-key",
        default=os.environ.get("COSMO_API_KEY", ""),
        help="Bearer API key (or set COSMO_API_KEY env var)",
    )
    parser.add_argument("--voice", default=None, help="Provider voice id (optional)")
    parser.add_argument(
        "--model", default=None, help="Model id (optional)"
    )
    args = parser.parse_args()

    if not args.api_key:
        parser.error("--api-key is required (or set COSMO_API_KEY)")

    asyncio.run(
        run(
            api_key=args.api_key,
            voice=args.voice,
            model=args.model,
        )
    )


if __name__ == "__main__":
    main()
