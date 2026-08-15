"""``TokenSource`` — the credential shape for distributed apps.

A shipped app must not hold an API key, and a static minted JWT expires
after 24 hours. A ``TokenSource`` closes the gap: it knows how to fetch a
fresh :class:`MintedToken` from the developer's own backend, caches it in
memory, and re-fetches when the cached token nears expiry — so
``RealtimeClient(token=TokenSource.endpoint(...))`` stays valid for the life
of the process with no refresh code in the app.
"""

from __future__ import annotations

import asyncio
import inspect
from datetime import datetime, timezone
from typing import Awaitable, Callable, Mapping, Union
from urllib.parse import urlparse

import httpx
import structlog
from pydantic import ValidationError

from cosmo_ai._internal.logging import get_logger
from cosmo_ai._internal.protocol import MintedToken
from cosmo_ai.errors import MintTokenError

logger: structlog.stdlib.BoundLogger = get_logger(__name__)

__all__ = ["FetchToken", "HeadersInput", "TokenSource"]

# Re-fetch this long before ``expires_at`` so an in-flight session start
# never races the expiry boundary. Matches the cross-SDK contract
# (``token-source-vectors.json``).
_REFRESH_SKEW_S = 60.0

_TOKEN_FETCH_TIMEOUT_S = 30.0

HeadersInput = Union[
    Mapping[str, str],
    Callable[[], Union[Mapping[str, str], Awaitable[Mapping[str, str]]]],
]
"""Headers attached to every token request — the app's own auth (its session
cookie rides automatically only same-origin; a bearer or custom header goes
here). Static, or a (possibly async) callback resolved per fetch."""

FetchToken = Callable[[], Awaitable[Union[MintedToken, Mapping[str, object]]]]
"""What ``TokenSource.custom`` takes: an async callable resolving with a
:class:`MintedToken`, or a mapping carrying ``jwt`` and ``expires_at`` (a
:class:`~datetime.datetime`, or the RFC 3339 string straight off a mint
response)."""


class TokenSource:
    """A credential that fetches — and keeps fresh — a minted end-user token.

    Pass one as ``token`` to :class:`~cosmo_ai.RealtimeClient`. The client asks
    the source for a JWT whenever a request needs auth; the source reuses its
    cached token while comfortably within its lifetime and re-fetches
    otherwise. A session-start rejected with HTTP 401 drops the cache, so the
    next start fetches fresh.

    Two constructors:

    * :meth:`endpoint` — POST a token endpoint that returns
      ``{jwt, expires_at}`` (the shape :meth:`~cosmo_ai.RealtimeClient.mint_token`
      responses already have; any backend that forwards ``POST auth/token``
      qualifies).
    * :meth:`custom` — any async callable resolving with ``{jwt, expires_at}``
      — full control over transport and auth.
    """

    def __init__(self, fetch_token: Callable[[], Awaitable[MintedToken]]) -> None:
        self._fetch_token = fetch_token
        self._cached: MintedToken | None = None
        self._inflight: asyncio.Task[MintedToken] | None = None

    @classmethod
    def endpoint(cls, url: str, *, headers: HeadersInput | None = None) -> "TokenSource":
        """A source that POSTs ``url`` (empty JSON body) and reads
        ``{jwt, expires_at}`` from the response — the wire shape of
        ``POST /api/v1/external/auth/token`` and of the token-server
        template. Rejections surface as :class:`MintTokenError` carrying the
        server's error slug when the body parses, else an ``http_<status>``
        synthetic; local failures carry ``token_source_failed``. The URL must
        be https (http only for localhost) — auth headers and JWTs must not
        cross the network in the clear."""
        _assert_supported_endpoint_url(url)
        return cls(lambda: _post_token_endpoint(url, headers))

    @classmethod
    def custom(cls, fetch_token: FetchToken) -> "TokenSource":
        """A source backed by ``fetch_token`` — called whenever a fresh token
        is needed. Resolve with ``{jwt, expires_at}``; a malformed result
        raises ``MintTokenError(code="token_source_failed")``."""

        async def fetch() -> MintedToken:
            return _normalize_fetched(await fetch_token())

        return cls(fetch)

    async def _get_jwt(self) -> str:
        """The JWT to send right now: cached while it has more than the
        refresh skew left, else one shared re-fetch (concurrent callers await
        the same request — and share its failure)."""
        cached = self._cached
        if cached is not None and _fresh(cached):
            return cached.jwt
        task = self._inflight
        if task is None:
            task = asyncio.ensure_future(self._fetch_and_store())
            self._inflight = task
            task.add_done_callback(self._clear_inflight)
        # Shielded so one cancelled caller doesn't kill the fetch the
        # others are awaiting.
        minted = await asyncio.shield(task)
        return minted.jwt

    async def _fetch_and_store(self) -> MintedToken:
        minted = await self._fetch_token()
        self._cached = minted
        return minted

    def _clear_inflight(self, _task: "asyncio.Task[MintedToken]") -> None:
        self._inflight = None

    def _invalidate(self) -> None:
        """Drop the cached token so the next :meth:`_get_jwt` re-fetches."""
        self._cached = None


def _fresh(cached: MintedToken) -> bool:
    remaining = cached.expires_at - datetime.now(timezone.utc)
    return remaining.total_seconds() > _REFRESH_SKEW_S


def _as_utc(expires_at: datetime) -> datetime:
    # A naive expiry (an RFC 3339 string without an offset) is read as UTC —
    # comparing it naive against the aware clock would raise instead.
    if expires_at.tzinfo is None:
        return expires_at.replace(tzinfo=timezone.utc)
    return expires_at


def _normalize_fetched(fetched: MintedToken | Mapping[str, object]) -> MintedToken:
    if isinstance(fetched, MintedToken):
        minted = fetched
    else:
        try:
            minted = MintedToken.model_validate(dict(fetched))
        except (ValidationError, TypeError) as exc:
            raise MintTokenError(
                code="token_source_failed",
                message="TokenSource.custom fetcher must return {jwt, expires_at}.",
            ) from exc
    if not minted.jwt:
        raise MintTokenError(
            code="token_source_failed",
            message="TokenSource.custom fetcher must return {jwt, expires_at}.",
        )
    return MintedToken(
        jwt=minted.jwt,
        expires_at=_as_utc(minted.expires_at),
        token_id=minted.token_id,
    )


_LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})


def _assert_supported_endpoint_url(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme == "https":
        return
    if parsed.scheme == "http" and parsed.hostname in _LOCAL_HOSTS:
        return
    raise ValueError(
        "TokenSource.endpoint must be an absolute https URL (http is allowed only for localhost)"
    )


async def _resolve_headers(headers: HeadersInput | None) -> Mapping[str, str]:
    if headers is None:
        return {}
    if callable(headers):
        resolved = headers()
        if inspect.isawaitable(resolved):
            resolved = await resolved
        return resolved
    return headers


async def _post_token_endpoint(url: str, headers: HeadersInput | None) -> MintedToken:
    # Deferred: client.py imports TokenSource at module scope.
    from cosmo_ai.client import _parse_error_detail

    extra = await _resolve_headers(headers)
    try:
        async with httpx.AsyncClient(timeout=_TOKEN_FETCH_TIMEOUT_S) as http:
            response = await http.post(
                url,
                json={},
                headers={**dict(extra), "Content-Type": "application/json"},
            )
    except httpx.HTTPError as exc:
        raise MintTokenError(code="token_source_failed", message=str(exc)) from exc
    if not response.is_success:
        code, message = _parse_error_detail(response)
        logger.warning(
            "realtime.token_source_rejected",
            status_code=response.status_code,
            code=code,
        )
        raise MintTokenError(code=code, message=message)
    try:
        body = response.json()
    except ValueError as exc:
        raise MintTokenError(
            code="token_source_failed",
            message="Token endpoint response was not JSON.",
        ) from exc
    if isinstance(body, dict) and "expires_at" not in body and "expiresAt" in body:
        # ``expiresAt`` is a serialized SDK ``MintedToken`` — a backend
        # returning its mint result as-is emits this spelling.
        body = {**body, "expires_at": body["expiresAt"]}
    try:
        minted = MintedToken.model_validate(body)
    except ValidationError as exc:
        raise MintTokenError(
            code="token_source_failed",
            message="Token endpoint response missing jwt / expires_at.",
        ) from exc
    if not minted.jwt:
        raise MintTokenError(
            code="token_source_failed",
            message="Token endpoint response missing jwt / expires_at.",
        )
    return MintedToken(
        jwt=minted.jwt,
        expires_at=_as_utc(minted.expires_at),
        token_id=minted.token_id,
    )
