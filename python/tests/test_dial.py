"""session.dial() / client._post_dial — the outbound-call REST path."""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import Callable

import httpx
import pytest

from cosmo_ai import RealtimeClient, DialError, DialResult
from cosmo_ai._internal.protocol import SessionConfig
from cosmo_ai.session import RealtimeSession

Handler = Callable[[httpx.Request], httpx.Response]

_DIAL_OK = {"dial_id": "550e8400-e29b-41d4-a716-446655440000"}


def _client(handler: Handler) -> RealtimeClient:
    return RealtimeClient(
        api_key="sk-secret",
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )


def test_post_dial_posts_phone_to_session_path_and_returns_result() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["body"] = json.loads(request.content)
        captured["auth"] = request.headers.get("authorization")
        return httpx.Response(200, json=_DIAL_OK)

    async def scenario() -> DialResult:
        return await _client(handler)._post_dial("sess-1", "+14155550199")

    result = asyncio.run(scenario())
    assert isinstance(result, DialResult)
    assert str(result.dial_id) == "550e8400-e29b-41d4-a716-446655440000"
    assert captured["url"].endswith(
        "/api/v1/external/realtime/session/sess-1/dial"
    )
    assert captured["body"] == {"phone_number": "+14155550199"}
    assert captured["auth"] == "Bearer sk-secret"


def test_post_dial_maps_server_slug_to_dial_error_code() -> None:
    """The external API wraps a typed rejection as
    ``{"error": {"type": "api_error", "code", "message"}}`` — the slug must
    surface as ``DialError.code`` (not ``http_403``)."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            403,
            json={
                "error": {
                    "type": "api_error",
                    "code": "phone_calls_disabled",
                    "message": "Outbound phone calls are disabled for this workspace.",
                }
            },
        )

    async def scenario() -> None:
        await _client(handler)._post_dial("sess-1", "+14155550199")

    with pytest.raises(DialError) as exc:
        asyncio.run(scenario())
    assert exc.value.code == "phone_calls_disabled"
    assert "disabled" in exc.value.message


def test_post_dial_legacy_nested_detail_still_parses() -> None:
    """Older backends nested ``{code, message}`` inside ``message`` — the
    parser keeps reading that shape for skew across the deploy boundary."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            403,
            json={
                "error": {
                    "type": "api_error",
                    "message": {
                        "code": "phone_calls_disabled",
                        "message": "Outbound phone calls are disabled for this workspace.",
                    },
                }
            },
        )

    async def scenario() -> None:
        await _client(handler)._post_dial("sess-1", "+14155550199")

    with pytest.raises(DialError) as exc:
        asyncio.run(scenario())
    assert exc.value.code == "phone_calls_disabled"
    assert "disabled" in exc.value.message


def test_post_dial_string_detail_surfaces_error_type_as_code() -> None:
    """A rejection whose detail is a plain string (auth / validation errors,
    which have no slug) surfaces the error ``type`` as the code and the string
    as the message — not raw JSON."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            403,
            json={
                "error": {
                    "type": "api_error",
                    "message": "API key missing required scopes: realtime:use",
                }
            },
        )

    async def scenario() -> None:
        await _client(handler)._post_dial("sess-1", "+14155550199")

    with pytest.raises(DialError) as exc:
        asyncio.run(scenario())
    assert exc.value.code == "api_error"
    assert "scopes" in exc.value.message


def test_post_dial_maps_malformed_success_to_invalid_response() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"unexpected": "shape"})

    async def scenario() -> None:
        await _client(handler)._post_dial("sess-1", "+14155550199")

    with pytest.raises(DialError) as exc:
        asyncio.run(scenario())
    assert exc.value.code == "invalid_response"


def _started_session(post_dial) -> RealtimeSession:
    """A session past start() without joining LiveKit — enough to exercise
    dial(), which only needs the bound post_dial and the session id."""
    session = RealtimeSession(config=SessionConfig(), post_dial=post_dial)
    session._response = SimpleNamespace(session_id="sess-42")  # type: ignore[assignment]
    return session


def test_dial_rejects_bad_number_before_any_request() -> None:
    async def post_dial(session_id: str, phone: str) -> DialResult:
        raise AssertionError("a malformed number must not reach the network")

    async def scenario() -> None:
        await _started_session(post_dial).dial("not-a-number")

    with pytest.raises(DialError) as exc:
        asyncio.run(scenario())
    assert exc.value.code == "invalid_phone_number"


def test_dial_delegates_session_id_and_normalised_number() -> None:
    captured: dict = {}

    async def post_dial(session_id: str, phone: str, caller: str | None) -> DialResult:
        captured["session_id"] = session_id
        captured["phone"] = phone
        captured["caller"] = caller
        return DialResult.model_validate(_DIAL_OK)

    async def scenario() -> DialResult:
        return await _started_session(post_dial).dial("  +14155550199  ")

    result = asyncio.run(scenario())
    assert captured["session_id"] == "sess-42"
    assert captured["phone"] == "+14155550199"  # surrounding whitespace stripped
    assert captured["caller"] is None  # omitted → trunk default
    assert str(result.dial_id) == "550e8400-e29b-41d4-a716-446655440000"


def test_dial_forwards_and_normalises_caller_number() -> None:
    captured: dict = {}

    async def post_dial(session_id: str, phone: str, caller: str | None) -> DialResult:
        captured["phone"] = phone
        captured["caller"] = caller
        return DialResult.model_validate(_DIAL_OK)

    async def scenario() -> DialResult:
        return await _started_session(post_dial).dial(
            "+14155550199", caller_number="  +14155550100  "
        )

    asyncio.run(scenario())
    assert captured["phone"] == "+14155550199"
    assert captured["caller"] == "+14155550100"  # surrounding whitespace stripped


def test_dial_rejects_malformed_caller_number_before_request() -> None:
    async def post_dial(session_id: str, phone: str, caller: str | None) -> DialResult:
        raise AssertionError("must not reach the transport on a bad caller-ID")

    async def scenario() -> None:
        await _started_session(post_dial).dial("+14155550199", caller_number="nope")

    with pytest.raises(DialError):
        asyncio.run(scenario())


def test_post_dial_includes_caller_number_in_body_when_set() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json=_DIAL_OK)

    async def scenario() -> DialResult:
        return await _client(handler)._post_dial(
            "sess-1", "+14155550199", "+14155550100"
        )

    asyncio.run(scenario())
    assert captured["body"] == {
        "phone_number": "+14155550199",
        "caller_number": "+14155550100",
    }


def test_post_dial_transport_failure_maps_to_transport_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    async def scenario() -> None:
        await _client(handler)._post_dial("sess-1", "+14155550199")

    with pytest.raises(DialError) as exc:
        asyncio.run(scenario())
    assert exc.value.code == "transport_error"
