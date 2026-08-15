"""mint_token (end-user JWT flow) + the api_key/token credential split."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Callable

import httpx
import pytest

from cosmo_ai import (
    RealtimeClient,
    CredentialsNotFoundError,
    MintedToken,
    MintTokenError,
)
from cosmo_ai._internal.protocol import SDK_NAME, SDK_VERSION
from cosmo_ai.client import _SESSION_START_TIMEOUT_S

Handler = Callable[[httpx.Request], httpx.Response]


def _client(handler: Handler, *, api_key: str | None = None, token: str | None = None) -> RealtimeClient:
    return RealtimeClient(
        api_key=api_key,
        token=token,
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )


def test_mint_token_posts_external_user_id_and_returns_minted_token() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["body"] = json.loads(request.content)
        captured["auth"] = request.headers.get("authorization")
        return httpx.Response(
            200, json={"jwt": "eyJabc", "expires_at": "2026-06-22T18:00:00Z"}
        )

    async def scenario() -> MintedToken:
        return await _client(handler, api_key="sk-secret").mint_token("user-123")

    minted = asyncio.run(scenario())
    assert isinstance(minted, MintedToken)
    assert minted.jwt == "eyJabc"
    assert minted.expires_at.year == 2026
    assert captured["url"].endswith("/api/v1/external/auth/token")
    assert captured["body"] == {"external_user_id": "user-123"}
    assert captured["auth"] == "Bearer sk-secret"


def test_mint_token_serializes_ttl_seconds_and_omits_when_absent() -> None:
    bodies: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        return httpx.Response(
            200, json={"jwt": "eyJabc", "expires_at": "2026-06-22T18:00:00Z"}
        )

    async def scenario() -> None:
        client = _client(handler, api_key="sk-secret")
        await client.mint_token("user-123", ttl_seconds=300)
        await client.mint_token("user-123")

    asyncio.run(scenario())
    assert bodies[0] == {"external_user_id": "user-123", "ttl_seconds": 300}
    assert bodies[1] == {"external_user_id": "user-123"}


def test_mint_token_requires_api_key_credential() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("token-only client must not reach the network")

    async def scenario() -> None:
        await _client(handler, token="end-user-jwt").mint_token("user-123")

    with pytest.raises(MintTokenError) as exc:
        asyncio.run(scenario())
    assert exc.value.code == "no_api_key"


def test_mint_token_raises_on_server_rejection() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            403, json={"detail": {"code": "forbidden", "message": "nope"}}
        )

    async def scenario() -> None:
        await _client(handler, api_key="sk-secret").mint_token("user-123")

    with pytest.raises(MintTokenError) as exc:
        asyncio.run(scenario())
    assert exc.value.code == "forbidden"


def test_mint_token_raises_on_malformed_success_body() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"unexpected": "shape"})

    async def scenario() -> None:
        await _client(handler, api_key="sk-secret").mint_token("user-123")

    with pytest.raises(MintTokenError) as exc:
        asyncio.run(scenario())
    assert exc.value.code == "invalid_response"


def test_at_most_one_credential_allowed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    with pytest.raises(ValueError):
        RealtimeClient(api_key="sk", token="jwt")
    # Zero arguments falls back to the resolution chain; with nothing to
    # resolve it raises the typed not-found error, not ValueError.
    monkeypatch.delenv("COSMO_API_KEY", raising=False)
    monkeypatch.setenv("COSMO_CREDENTIALS_FILE", str(tmp_path / "credentials"))
    with pytest.raises(CredentialsNotFoundError):
        RealtimeClient()


def test_base_url_must_be_https_for_remote_hosts(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COSMO_BASE_URL", "http://evil.example.com")
    with pytest.raises(ValueError):
        RealtimeClient(api_key="sk")
    # https anywhere, and http for localhost, are allowed
    monkeypatch.setenv("COSMO_BASE_URL", "https://api.test")
    RealtimeClient(api_key="sk")
    monkeypatch.setenv("COSMO_BASE_URL", "http://localhost:8000")
    RealtimeClient(api_key="sk")


def test_defaults_to_prod_base_url_when_env_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("COSMO_BASE_URL", raising=False)
    client = RealtimeClient(api_key="sk")
    assert client._base_url == "https://platform.askcosmo.ai"


@pytest.mark.parametrize("value", ["", "   ", "\n"])
def test_blank_base_url_is_treated_as_unset(
    monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    monkeypatch.setenv("COSMO_BASE_URL", value)
    assert RealtimeClient(api_key="sk")._base_url == "https://platform.askcosmo.ai"


def test_base_url_is_trimmed_and_stripped_of_trailing_slashes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("COSMO_BASE_URL", "  https://api.test//  ")
    assert RealtimeClient(api_key="sk")._base_url == "https://api.test"


def test_credential_is_stored_as_secretstr() -> None:
    client = RealtimeClient(api_key="sk-secret")
    assert client._credential is not None
    assert client._credential.get_secret_value() == "sk-secret"
    assert "sk-secret" not in str(client._credential)
    assert "sk-secret" not in repr(client._credential)


def test_custom_http_client_is_used_and_not_closed_by_aclose() -> None:
    async def scenario() -> None:
        injected = httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda req: httpx.Response(
                    200, json={"jwt": "x", "expires_at": "2026-06-22T18:00:00Z"}
                )
            )
        )
        client = RealtimeClient(api_key="sk", http_client=injected)
        assert client._http() is injected
        await client.mint_token("user-1")  # routes through the injected client
        await client.aclose()
        assert not injected.is_closed  # caller owns it — aclose() must not close it
        await injected.aclose()

    asyncio.run(scenario())


def test_owned_http_client_is_closed_by_aclose() -> None:
    async def scenario() -> None:
        client = RealtimeClient(api_key="sk")
        owned = client._http()
        await client.aclose()
        assert owned.is_closed

    asyncio.run(scenario())


def test_session_requests_use_sdk_timeout_even_with_a_short_client_default() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["timeout"] = request.extensions.get("timeout")
        return httpx.Response(
            200, json={"jwt": "x", "expires_at": "2026-06-22T18:00:00Z"}
        )

    async def scenario() -> None:
        # An injected client with a 1s default must not shorten session-start /
        # mint: the SDK pins its own timeout per request.
        injected = httpx.AsyncClient(timeout=1.0, transport=httpx.MockTransport(handler))
        client = RealtimeClient(api_key="sk", http_client=injected)
        await client.mint_token("user-1")
        await injected.aclose()

    asyncio.run(scenario())
    assert captured["timeout"] is not None
    assert captured["timeout"]["read"] == _SESSION_START_TIMEOUT_S


def test_credential_is_sent_as_bearer() -> None:
    async def scenario() -> None:
        for client, expected in (
            (RealtimeClient(api_key="sk-secret"), "Bearer sk-secret"),
            (RealtimeClient(token="end-user-jwt"), "Bearer end-user-jwt"),
        ):
            # Auth is attached per request (so an injected http_client needn't know it);
            # the wire delivery is asserted in the mint round-trip test above.
            headers = await client._auth_headers()
            assert headers["Authorization"] == expected
            assert headers["X-Cosmo-SDK"] == f"{SDK_NAME}/{SDK_VERSION}"

    asyncio.run(scenario())


def test_mint_token_transport_failure_maps_to_transport_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    async def scenario() -> None:
        await _client(handler, api_key="sk").mint_token("user-123")

    with pytest.raises(MintTokenError) as exc:
        asyncio.run(scenario())
    assert exc.value.code == "transport_error"
