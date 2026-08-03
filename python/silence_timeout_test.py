"""Manual e2e for the PR2 server-side silence monitor.

Connects a session configured with a short user-speech-timeout, then stays
SILENT (sends nothing). The worker's silence monitor should fire after
`timeout_seconds`, make the agent speak the idle message, and emit a
`user-speech-timeout` frame — which this script prints.

No microphone needed: the user never speaks, so VAD never reports "speaking",
the silence clock accrues from session start, and the monitor fires.

Requires a LOCAL backend + realtime worker running THIS branch
(realtime-silence-monitor) — the running services must have the silence-monitor
code, or nothing fires.

Usage:
    export COSMO_API_KEY=cosmo_...                     # a local workspace api key
    export COSMO_BASE_URL=https://localhost:8000    # your local backend
    python examples/silence_timeout_test.py
"""

import asyncio
import os

import httpx

from cosmo_ai import (
    CosmoRealtime,
    RealtimeUserSpeechTimeout,
    RealtimeError,
    RealtimeReady,
    RealtimeSessionEnded,
    RealtimeTranscriptDelta,
    RealtimeTranscriptRole,
)
from cosmo_ai.hooks import Say, SilenceTimeout

TIMEOUT_SECONDS = 8.0   # keep it short for testing (prod would be ~minutes)
WATCH_SECONDS = 40      # stay connected long enough to see a couple of fires


async def main() -> None:
    api_key = os.environ.get("COSMO_API_KEY")
    if not api_key:
        raise SystemExit("Set COSMO_API_KEY (a local workspace api key).")
    base_url = os.environ.get("COSMO_BASE_URL") or ""
    if "askcosmo.ai" in base_url:
        raise SystemExit("Point COSMO_BASE_URL at your LOCAL backend, not prod.")
    # Local backend uses a self-signed cert — skip TLS verification for localhost.
    is_local = "localhost" in base_url or "127.0.0.1" in base_url
    http_client = httpx.AsyncClient(verify=False) if is_local else None

    async with CosmoRealtime(api_key=api_key, http_client=http_client) as client:
        agent = client.agent(
            instructions="You are a friendly support agent.",
            hooks=[
                SilenceTimeout(
                    timeout_seconds=TIMEOUT_SECONDS,
                    action=Say(text="Are you still there?"),
                    max_count=2,
                    reset_mode="never",
                ),
            ],
        )
        async with agent.start() as session:
            print(f"Connected — session_id={session.session_id}")
            print(f"Staying SILENT; expecting an idle nudge after ~{TIMEOUT_SECONDS:.0f}s…\n")

            async def stopper() -> None:
                await asyncio.sleep(WATCH_SECONDS)
                await session.end()

            asyncio.create_task(stopper())

            fires = 0
            async for event in session:
                if isinstance(event, RealtimeReady):
                    print(f"[ready] session_id={event.session_id}")
                elif isinstance(event, RealtimeUserSpeechTimeout):
                    fires += 1
                    print(
                        f"[✓ SILENCE TIMEOUT FIRED] #{event.trigger_count}/{event.max_count} "
                        f"after {event.silence_ms} ms — action={event.action}"
                    )
                elif isinstance(event, RealtimeTranscriptDelta):
                    if event.role is RealtimeTranscriptRole.ASSISTANT:
                        marker = "»" if event.is_final else "…"
                        print(f"[agent said] {event.text}{marker}")
                elif isinstance(event, RealtimeError):
                    print(f"[error] {event.code}: {event.message}")
                elif isinstance(event, RealtimeSessionEnded):
                    break

            print(f"\nDone. Silence timeout fired {fires} time(s) "
                  f"(expected up to max_count=2).")


if __name__ == "__main__":
    asyncio.run(main())
