"""session.usage() / client.get_session_usage — the usage-summary REST read."""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import Callable

import httpx
import pytest

from cosmo_ai import (
    RealtimeClient,
    SessionStatus,
    UsageError,
    UsageStatus,
    SessionUsage,
    NotConnectedError,
)
from cosmo_ai._internal.protocol import SessionConfig
from cosmo_ai.session import RealtimeSession

Handler = Callable[[httpx.Request], httpx.Response]

_RECORDED_BODY = {
    "status": "completed",
    "usage_status": "recorded",
    "duration_seconds": 121.0,
    "turn_count": 7,
    "user_speaking_seconds": 41.5,
    "agent_speaking_seconds": 63.25,
    "provider": "gemini",
    "model": "gemini-3.1-flash-live-preview",
    "tokens": {
        "input_tokens": 900,
        "output_tokens": 400,
        "total_tokens": 1300,
        "input_audio_tokens": 700,
        "input_text_tokens": 150,
        "input_image_tokens": 20,
        "input_cached_tokens": 30,
        "output_audio_tokens": 350,
        "output_text_tokens": 50,
    },
}

# What the server sends while the session is live (or before the detailed
# summary lands): the two statuses, everything else null.
_PENDING_BODY = {
    "status": "active",
    "usage_status": "pending",
    "duration_seconds": None,
    "turn_count": None,
    "user_speaking_seconds": None,
    "agent_speaking_seconds": None,
    "provider": "gemini",
    "model": None,
    "tokens": None,
}


def _client(handler: Handler) -> RealtimeClient:
    return RealtimeClient(
        api_key="sk-secret",
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )


def test_get_session_usage_gets_the_usage_path_and_parses() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["method"] = request.method
        captured["url"] = str(request.url)
        captured["auth"] = request.headers.get("authorization")
        return httpx.Response(200, json=_RECORDED_BODY)

    async def scenario() -> SessionUsage:
        return await _client(handler).get_session_usage("sess-1")

    usage = asyncio.run(scenario())
    assert isinstance(usage, SessionUsage)
    assert usage.status is SessionStatus.COMPLETED
    assert usage.usage_status is UsageStatus.RECORDED
    assert usage.duration_seconds == 121.0
    assert usage.turn_count == 7
    assert usage.user_speaking_seconds == 41.5
    assert usage.agent_speaking_seconds == 63.25
    assert usage.provider == "gemini"
    assert usage.model == "gemini-3.1-flash-live-preview"
    assert usage.tokens is not None
    assert usage.tokens.input_tokens == 900
    assert usage.tokens.output_tokens == 400
    assert usage.tokens.total_tokens == 1300
    assert usage.tokens.input_cached_tokens == 30
    assert captured["method"] == "GET"
    assert captured["url"].endswith(
        "/api/v1/external/sessions/sess-1/usage"
    )
    assert captured["auth"] == "Bearer sk-secret"


def test_get_session_usage_parses_a_pending_summary() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_PENDING_BODY)

    async def scenario() -> SessionUsage:
        return await _client(handler).get_session_usage("sess-1")

    usage = asyncio.run(scenario())
    assert usage.status is SessionStatus.ACTIVE
    assert usage.usage_status is UsageStatus.PENDING
    assert usage.duration_seconds is None
    assert usage.tokens is None


def test_unknown_status_values_fall_back_to_the_raw_string() -> None:
    """A server state this SDK version predates must read, not raise —
    otherwise adding one breaks every already-shipped Python client."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={**_PENDING_BODY, "status": "archived", "usage_status": "expired"},
        )

    async def scenario() -> SessionUsage:
        return await _client(handler).get_session_usage("sess-1")

    usage = asyncio.run(scenario())
    assert usage.status == "archived"
    assert usage.usage_status == "expired"


def test_get_session_usage_maps_server_slug_to_usage_error_code() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            404,
            json={
                "error": {
                    "type": "api_error",
                    "code": "not_found",
                    "message": "voice session sess-1 not found",
                }
            },
        )

    async def scenario() -> None:
        await _client(handler).get_session_usage("sess-1")

    with pytest.raises(UsageError) as exc:
        asyncio.run(scenario())
    assert exc.value.code == "not_found"
    assert "not found" in exc.value.message


def test_get_session_usage_maps_malformed_success_to_invalid_response() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"unexpected": "shape"})

    async def scenario() -> None:
        await _client(handler).get_session_usage("sess-1")

    with pytest.raises(UsageError) as exc:
        asyncio.run(scenario())
    assert exc.value.code == "invalid_response"


def test_get_session_usage_maps_transport_failure() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("boom")

    async def scenario() -> None:
        await _client(handler).get_session_usage("sess-1")

    with pytest.raises(UsageError) as exc:
        asyncio.run(scenario())
    assert exc.value.code == "transport_error"


def _started_session(get_usage) -> RealtimeSession:
    """A session past start() without joining LiveKit — enough to exercise
    usage(), which only needs the bound get_usage and the session id."""
    session = RealtimeSession(config=SessionConfig(), get_usage=get_usage)
    session._response = SimpleNamespace(session_id="sess-42")  # type: ignore[assignment]
    return session


def test_usage_delegates_the_session_id() -> None:
    captured: dict = {}

    async def get_usage(session_id: str) -> SessionUsage:
        captured["session_id"] = session_id
        return SessionUsage.model_validate(_RECORDED_BODY)

    async def scenario() -> SessionUsage:
        return await _started_session(get_usage).usage()

    usage = asyncio.run(scenario())
    assert captured["session_id"] == "sess-42"
    assert usage.usage_status is UsageStatus.RECORDED


def test_usage_without_support_raises_usage_error() -> None:
    async def scenario() -> None:
        await _started_session(None).usage()

    with pytest.raises(UsageError) as exc:
        asyncio.run(scenario())
    assert exc.value.code == "not_supported"


@pytest.mark.parametrize("supported", [True, False])
def test_usage_before_start_raises_not_connected(supported: bool) -> None:
    """Never-started is answered first, so a session that also lacks usage
    support still reports the reason the caller can act on."""

    async def get_usage(session_id: str) -> SessionUsage:
        raise AssertionError("must not reach the transport before start")

    async def scenario() -> None:
        session = RealtimeSession(
            config=SessionConfig(), get_usage=get_usage if supported else None
        )
        await session.usage()

    with pytest.raises(NotConnectedError):
        asyncio.run(scenario())
