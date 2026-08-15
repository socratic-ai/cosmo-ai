"""verify() — the free credential preflight."""

from __future__ import annotations

import asyncio
from typing import Callable

import httpx
import pytest

from cosmo_ai import CredentialInfo, CredentialKind, RealtimeClient, VerifyError

Handler = Callable[[httpx.Request], httpx.Response]

_OK_BODY = {
    "credential": "api_key",
    "workspace": {"name": "Acme", "slug": "acme"},
    "scopes": ["realtime:use"],
    "can_start_sessions": True,
    "realtime_voice_available": True,
    "external_user_id": None,
}

# What the server sends a minted token: ``workspace`` serialized as null.
_TOKEN_BODY = {
    "credential": "user_token",
    "workspace": None,
    "scopes": ["realtime:use"],
    "can_start_sessions": True,
    "realtime_voice_available": True,
    "external_user_id": "user-123",
}


def _client(
    handler: Handler, *, api_key: str | None = None, token: str | None = None
) -> RealtimeClient:
    return RealtimeClient(
        api_key=api_key,
        token=token,
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )


def test_verify_gets_the_preflight_and_returns_credential_info() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["method"] = request.method
        captured["url"] = str(request.url)
        captured["auth"] = request.headers.get("authorization")
        return httpx.Response(200, json=_OK_BODY)

    async def scenario() -> CredentialInfo:
        return await _client(handler, api_key="sk-secret").verify()

    info = asyncio.run(scenario())
    assert isinstance(info, CredentialInfo)
    assert info.credential is CredentialKind.API_KEY
    assert info.workspace is not None
    assert info.workspace.slug == "acme"
    assert info.scopes == ["realtime:use"]
    assert info.can_start_sessions is True
    assert info.realtime_voice_available is True
    assert info.external_user_id is None
    assert captured["method"] == "GET"
    assert captured["url"].endswith("/api/v1/external/realtime/verify")
    assert captured["auth"] == "Bearer sk-secret"


def test_verify_works_with_a_minted_token_credential() -> None:
    """A device-held token can preflight itself — the mint-only guard on
    ``mint_token`` has no counterpart here. It learns what it may do without
    learning the workspace it belongs to."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_TOKEN_BODY)

    async def scenario() -> CredentialInfo:
        return await _client(handler, token="end-user-jwt").verify()

    info = asyncio.run(scenario())
    assert info.credential is CredentialKind.USER_TOKEN
    assert info.external_user_id == "user-123"
    assert info.workspace is None
    assert info.can_start_sessions is True


def test_verify_reports_an_under_scoped_credential_without_raising() -> None:
    """The whole point: a valid-but-unusable credential is a returned fact,
    not an exception a caller has to distinguish from a bad key."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                **_OK_BODY,
                "scopes": ["chat:read"],
                "can_start_sessions": False,
                "realtime_voice_available": False,
            },
        )

    async def scenario() -> CredentialInfo:
        return await _client(handler, api_key="sk-secret").verify()

    info = asyncio.run(scenario())
    assert info.can_start_sessions is False
    assert info.realtime_voice_available is False


def test_verify_raises_on_rejected_credential() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            401, json={"detail": {"code": "auth_failed", "message": "bad key"}}
        )

    async def scenario() -> None:
        await _client(handler, api_key="sk-secret").verify()

    with pytest.raises(VerifyError) as exc:
        asyncio.run(scenario())
    assert exc.value.code == "auth_failed"


def test_verify_raises_on_transport_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route to host")

    async def scenario() -> None:
        await _client(handler, api_key="sk-secret").verify()

    with pytest.raises(VerifyError) as exc:
        asyncio.run(scenario())
    assert exc.value.code == "transport_error"


def test_verify_raises_on_malformed_success_body() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"unexpected": "shape"})

    async def scenario() -> None:
        await _client(handler, api_key="sk-secret").verify()

    with pytest.raises(VerifyError) as exc:
        asyncio.run(scenario())
    assert exc.value.code == "invalid_response"
