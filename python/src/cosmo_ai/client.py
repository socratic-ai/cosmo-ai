"""Entry point: ``RealtimeClient`` (connection) → :class:`RealtimeAgent` (persona) →
session (one live run).

The three objects map to the three concerns of running a session:

* **``RealtimeClient``** — how to reach Cosmo: credential, endpoint, HTTP
  transport. Holds nothing about what the agent is or how a run behaves.
* **:class:`RealtimeAgent`** — the persona/configuration of the model on the other
  end: instructions, model, voice, tools, turn-taking. Reusable across runs.
* **session** (``agent.start(...)``) — one live run plus its per-run,
  transport-level options: inbound-audio cleanup, resume, lifecycle observer.

Usage::

    client = RealtimeClient(api_key="cosmo_...")
    agent = client.agent(instructions="You are terse.", voice="Puck")
    async with agent.start() as session:
        async for event in session:
            ...

A session can be prepared ahead of its start (:meth:`RealtimeAgent.prepare_session`)
so the start joins a room reserved in the background instead of waiting for
one to be allocated::

    prepared = agent.prepare_session()
    ...  # the rest of the app's setup
    async with prepared.start() as session:
        ...
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import time
import warnings
from dataclasses import dataclass, field
from typing import (
    Any,
    Awaitable,
    Callable,
    Generator,
    Mapping,
    Optional,
    Protocol,
    Sequence,
)
from urllib.parse import urlparse
from uuid import UUID

import httpx
import structlog
from pydantic import SecretStr, ValidationError

from cosmo_ai._internal.logging import get_logger
from cosmo_ai._internal.prepared_room import PREPARED_ROOM_REFRESH_S, PreparedRoom
from cosmo_ai.errors import (
    DialErrorCode,
    SessionStartErrorCode,
    SessionStartRejection,
    UsageErrorCode,
    VerifyErrorCode,
    _classify_start_rejection,
    CredentialsError,
    CredentialsErrorCode,
    DialError,
    MintTokenError,
    MintTokenErrorCode,
    SessionStartError,
    UsageError,
    VerifyError,
)
from cosmo_ai._internal.hooks import Hook, HookEngine, resolve_hooks
from cosmo_ai.mcp._engine import ConnectedMcp, McpInput, McpStdioServer, connect_mcp, resolve_mcp
from cosmo_ai._internal.protocol import (
    SDK_NAME,
    SDK_VERSION,
    _sdk_info,
    AgentTool,
    AudioConfig,
    ClientTool,
    CredentialInfo,
    DialResult,
    InterruptionSensitivity,
    MintedToken,
    ExperimentalParams,
    InlineAgentConfig,
    CatalogAgentConfig,
    SessionConfig,
    SessionParams,
    SessionResponse,
    RealtimeModel,
    ServerHook,
    VoiceConfig,
    SessionUsage,
    WsSessionStart,
    parse_minted_token,
)
from cosmo_ai._internal.transport import (
    StartedSession,
    TransportName,
)
from cosmo_ai.session._engine import (
    GetUsage,
    OnStateChange,
    PostDial,
    RealtimeSession,
)
from cosmo_ai.skills._engine import (
    Skill,
    SkillsInput,
    build_load_skill_tool,
    menu_text,
    resolve_skills,
)
from cosmo_ai._internal.credentials_file import resolve_credential
from cosmo_ai.plugins import Plugin, _resolve_plugins
from cosmo_ai.token_source import TokenSource
from cosmo_ai.tools._sdk_tools import assert_no_reserved_tool_names

logger: structlog.stdlib.BoundLogger = get_logger(__name__)

_SESSION_PATH = "/api/v1/external/realtime/session"
_SESSION_START_PATH = f"{_SESSION_PATH}/start"
_SESSION_WS_START_PATH = f"{_SESSION_PATH}/ws-start"
_PREPARE_ROOM_PATH = f"{_SESSION_PATH}/prepare-room"
_MINT_TOKEN_PATH = "/api/v1/external/auth/token"
_VERIFY_PATH = "/api/v1/external/realtime/verify"
_SESSIONS_PATH = "/api/v1/external/sessions"
_SESSION_START_TIMEOUT_S = 40.0
# Sized with the other SDKs rather than with session start, which is bounded
# by the backend's agent dispatch (``contract/mint-vectors.json``).
_MINT_TOKEN_TIMEOUT_S = 45.0
_LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
_DEFAULT_BASE_URL = "https://platform.askcosmo.ai"
_BASE_URL_ENV_VAR = "COSMO_BASE_URL"
_TRANSPORT_ENV_VAR = "COSMO_TRANSPORT"


def _as_tuple(
    tools: Sequence[AgentTool] | None,
) -> tuple[AgentTool, ...] | None:
    return tuple(tools) if tools is not None else None



def _retry_after_seconds(response: httpx.Response) -> int | None:
    """The server's ``Retry-After`` in whole seconds, when it sent one as a
    delay, never below zero. An HTTP-date form is ignored: the SDK reports what
    the server asked for, not a value derived from a clock it does not
    share."""
    raw = response.headers.get("retry-after")
    if raw is None:
        return None
    try:
        return max(0, int(raw.strip()))
    except ValueError:
        return None

class RealtimeClient:
    """Async client for the Cosmo realtime external API.

    Construct with at most one credential:

    * ``api_key`` — workspace-scoped, server-side only. Can mint end-user
      tokens (:meth:`mint_token`) and open sessions.
    * ``token`` — a minted end-user JWT (from :meth:`mint_token`), scoped to
      one external user. Safe for a browser/device; can open sessions but
      cannot mint. Pass a :class:`TokenSource` instead of the raw string and
      the client fetches the JWT itself — from your token endpoint
      (:meth:`TokenSource.endpoint`) or a custom fetcher — re-fetching as
      expiry nears, so a long-lived app never handles refresh.
    * Neither — the SDK resolves an API key itself: ``COSMO_API_KEY`` from
      the environment, else the ``cosmo login`` credentials file
      (``COSMO_CREDENTIALS_FILE`` or ``~/.cosmo/credentials``, profile from
      ``COSMO_PROFILE``). A file credential brings its own ``base_url``
      along, since a stored key is only valid against the backend that
      issued it. Raises :class:`cosmo_ai.CredentialsError` when nothing
      resolves, the file is unusable, or the stored key expired.

    The API is reached at ``https://platform.askcosmo.ai`` by default. Point
    the SDK at another backend for local development by setting the
    ``COSMO_BASE_URL`` environment variable (``http://`` is allowed only for
    localhost).

    ``http_client`` lets you supply your own :class:`httpx.AsyncClient` for
    full control of TLS (custom CA bundle / ``SSLContext`` / mTLS), proxies,
    and transport — e.g. against a private-CA or self-signed https backend.
    The SDK applies its own timeout to session-start / mint requests per call,
    so an injected client's timeout never shortens them. When omitted, the SDK
    owns an ``httpx.AsyncClient`` and closes it on :meth:`aclose` / context
    exit; an injected client is left open (you own its lifecycle).
    """

    def __init__(
        self,
        *,
        api_key: str | None = None,
        token: str | TokenSource | None = None,
        transport: TransportName | None = None,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        if api_key is not None and token is not None:
            raise CredentialsError(
                code=CredentialsErrorCode.CONFLICTING_CREDENTIALS,
                message="provide at most one of api_key or token",
            )
        # Normalize before the guard below reads the value. A key pasted with
        # a byte-order mark would otherwise slip past the ``cosmo_`` prefix
        # check and then be cleaned into a working bearer credential, which is
        # the exact mistake that check exists to refuse.
        if isinstance(api_key, str):
            api_key = _clean_credential(api_key)
        if isinstance(token, str):
            token = _clean_credential(token)
        if (
            isinstance(token, str)
            and token.startswith("cosmo_")
            and not token.startswith("cosmo_pat_")
        ):
            # The backend would honor a key as a bearer, which is exactly how
            # a pasted key ends up shipped to end users. Refuse it here.
            raise CredentialsError(
                code=CredentialsErrorCode.API_KEY_IN_TOKEN_SLOT,
                message="this is a workspace API key (cosmo_…), not a minted "
                "end-user token — pass api_key=..., or mint a token for this "
                "user with mint_token() and pass that",
            )
        resolved_base_url: str | None = None
        if api_key is None and token is None:
            resolved = resolve_credential()
            api_key = resolved.api_key
            resolved_base_url = resolved.base_url
        self._can_mint = api_key is not None
        if isinstance(token, TokenSource):
            self._token_source: TokenSource | None = token
            self._credential: SecretStr | None = None
        else:
            self._token_source = None
            credential = api_key if api_key is not None else token
            assert credential is not None  # one branch above always sets one
            self._credential = SecretStr(_clean_credential(credential))
        base_url = (
            resolved_base_url
            or (os.environ.get(_BASE_URL_ENV_VAR) or "").strip()
            or _DEFAULT_BASE_URL
        )
        self._base_url = base_url.rstrip("/")
        parsed = urlparse(self._base_url)
        if parsed.scheme != "https" and parsed.hostname not in _LOCAL_HOSTS:
            raise CredentialsError(
                code=CredentialsErrorCode.INSECURE_BASE_URL,
                message=f"{_BASE_URL_ENV_VAR} must use https:// "
                "(http is allowed only for localhost)",
            )
        self._transport: TransportName = _resolve_transport(transport)
        self._http_client: httpx.AsyncClient | None = http_client
        self._owns_http_client = http_client is None

    def agent(
        self,
        *,
        instructions: str | None = None,
        model: RealtimeModel | None = None,
        voice: str | VoiceConfig | None = None,
        tools: Sequence[AgentTool] | None = None,
        interruption_sensitivity: InterruptionSensitivity | None = None,
        greeting: str | None = None,
        audio: AudioConfig | None = None,
        mcp: McpInput | None = None,
        skills: SkillsInput | None = None,
        hooks: Sequence[Hook | ServerHook] | None = None,
        plugins: Sequence[Plugin] | None = None,
    ) -> "RealtimeAgent":
        """Build an inline :class:`RealtimeAgent` — the persona/configuration of the
        model on the other end (instructions, model, voice, tools,
        turn-taking, its opening ``greeting``, its ``audio`` pipeline),
        reusable across any number of sessions.

        ``voice`` takes either the prebuilt voice id as a plain string or a
        :class:`VoiceConfig` when a speaking style rides along.

        To run a workspace catalog agent by handle instead, use
        :meth:`catalog_agent` — this factory has no catalog-launch parameters, so
        the two cannot be mixed.

        ``skills`` is a skills directory (``<skill>/SKILL.md`` folders, or a
        single skill's own folder), or a list mixing directories and inline
        :class:`~cosmo_ai.skills.Skill` objects (a path element expands
        in place); a bad path or malformed SKILL.md raises
        :class:`~cosmo_ai.skills.SkillError` here, not mid-call. A
        directory that yields no skills warns and attaches none.

        Fields left ``None`` fall back to the protocol's server-side defaults
        — ``audio.noise_cancellation`` among them, which is off; pass
        ``AudioConfig(noise_cancellation=NoiseCancellation.VOICE_FOCUS)`` when the microphone will
        hear more than one voice. Open a live run with :meth:`RealtimeAgent.start`.

        :param instructions: System instructions replacing the server's
            neutral default. This SDK caps them at 16384 characters and
            rejects a longer value when the session config is built.
        :param model: What runs on the other end — a provider family alias
            or concrete model id as a string (``"gemini"``, ``"openai"``,
            ``"openai_mini"``, ``"grok"``), or a provider block
            (:class:`GeminiModel`, :class:`OpenAIModel`, …) carrying that
            provider's knobs. The valid set is server-owned, so an
            unrecognized value is refused when the session starts.
        :param voice: Prebuilt voice id as a string, or :class:`VoiceConfig`
            when a speaking style rides along.
        :param tools: Everything the agent may call — tools you declare with
            :func:`~cosmo_ai.tools.client_tool` or the ``@tool`` decorator,
            plus server-tool opt-ins like :func:`~cosmo_ai.web_search_tool`.
        :param interruption_sensitivity: How readily user audio barges in
            over the assistant. See :class:`InterruptionSensitivity`.
        :param greeting: Opening line the assistant speaks first, without
            waiting for the user.
        :param audio: The agent's audio pipeline — output emission and
            inbound noise cancellation. See :class:`AudioConfig`.
        :param mcp: Local MCP servers whose tools the agent may call: a
            path to one ``.mcp.json``, or a list mixing such paths with
            :class:`~cosmo_ai.mcp.McpStdioServer` values.
        :param skills: A skills directory, or a list mixing directories with
            inline :class:`~cosmo_ai.skills.Skill` objects.
        :param plugins: Bundles expanded in order before directly supplied contributions.
        :param hooks: In-process callbacks that observe or gate the session
            (:class:`~cosmo_ai.hooks.Hook`), and declarative server-side
            hooks (:class:`~cosmo_ai.hooks.ServerHook`) the server runs.
        :raises SkillError: A skills path is unreadable or a ``SKILL.md`` is
            malformed.
        :raises McpError: An MCP config path is unreadable or malformed, or
            two servers share a name.
        """
        resolved_skills = resolve_skills(skills)
        if plugins:
            combined = _resolve_plugins(
                plugins,
                Plugin(
                    name="agent",
                    instructions=instructions,
                    skills=resolved_skills or (),
                    tools=tools or (),
                    hooks=hooks or (),
                ),
            )
            instructions, tools, hooks = combined.instructions, combined.tools, combined.hooks
            resolved_skills = tuple(combined.skills)
        return RealtimeAgent(
            _client=self,
            instructions=instructions,
            model=model,
            voice=voice,
            tools=_as_tuple(tools),
            interruption_sensitivity=interruption_sensitivity,
            greeting=greeting,
            audio=audio,
            mcp=resolve_mcp(mcp),
            skills=resolved_skills,
            hooks=resolve_hooks(hooks),
        )

    def catalog_agent(
        self,
        name: str,
        *,
        inputs: Mapping[str, str] | None = None,
        voice: str | VoiceConfig | None = None,
        tools: Sequence[AgentTool] | None = None,
        mcp: McpInput | None = None,
        hooks: Sequence[Hook] | None = None,
    ) -> "RealtimeAgent":
        """Build an :class:`RealtimeAgent` that runs a workspace catalog agent by its
        machine handle. The server resolves the handle at session start and
        runs the stored config verbatim.

        Only per-run ride-alongs are accepted: ``inputs`` (values for the
        agent's declared input fields), ``voice`` (cosmetic override; unset
        keeps the stored voice), ``tools`` / ``mcp`` (client-executed
        declarations the server cannot provide), and ``hooks`` (local event
        hooks; never serialized). Other stored-config fields
        (``instructions``, ``model``, ...) have no parameter here — the
        illegal combination is a type error, not a server rejection.
        """
        return RealtimeAgent(
            _client=self,
            name=name,
            inputs=inputs,
            voice=voice,
            tools=_as_tuple(tools),
            mcp=resolve_mcp(mcp),
            hooks=resolve_hooks(hooks, server_allowed=False),
        )

    async def verify(self) -> CredentialInfo:
        """Check the credential without starting a session (GET
        ``realtime/verify``).

        A free preflight for a startup check or a CI smoke test: it confirms
        the credential authenticates against this base URL, and the result
        separates the failure modes a first session would otherwise conflate
        — under-scoped (``can_start_sessions``) versus a deployment with no
        default voice stack configured (``realtime_voice_available``).

        Raises :class:`VerifyError` if the credential is rejected or the
        request fails.
        """
        try:
            response = await self._http().get(
                f"{self._base_url}{_VERIFY_PATH}",
                headers=await self._auth_headers(),
                timeout=_SESSION_START_TIMEOUT_S,
            )
        except httpx.HTTPError as exc:
            raise VerifyError(code=VerifyErrorCode.REQUEST_FAILED, message=str(exc)) from exc
        if response.status_code >= 400:
            code, message = _parse_error_detail(response)
            logger.warning(
                "realtime.verify_rejected",
                status_code=response.status_code,
                code=code,
            )
            raise VerifyError(code=VerifyErrorCode.REQUEST_REJECTED, message=message, server_code=code)
        try:
            return CredentialInfo.model_validate(response.json())
        except (ValidationError, ValueError) as exc:
            raise VerifyError(code=VerifyErrorCode.INVALID_RESPONSE, message=str(exc)) from exc

    async def mint_token(
        self, external_user_id: str, *, ttl_seconds: int | None = None
    ) -> MintedToken:
        """Mint a short-lived end-user token for ``external_user_id`` (POST
        ``auth/token``).

        Run this on your backend with an ``api_key`` client; hand the returned
        ``jwt`` to the end user's browser/device, which constructs
        ``RealtimeClient(token=jwt)`` and opens a session with
        ``client.agent(...).start()``. Idempotent per
        ``(workspace, external_user_id)`` — the same external user maps to the
        same auto-provisioned project on repeat calls. ``ttl_seconds``
        (60–86400) shortens the 24-hour default lifetime.

        Raises :class:`MintTokenError` if this client has no ``api_key`` (a
        token-credentialed client cannot mint) or the server rejects it.
        """
        if not self._can_mint:
            raise MintTokenError(
                code=MintTokenErrorCode.MISSING_API_KEY,
                message="mint_token requires an api_key credential, not a minted token",
            )
        body: dict[str, object] = {"external_user_id": external_user_id}
        if ttl_seconds is not None:
            body["ttl_seconds"] = ttl_seconds
        try:
            response = await self._http().post(
                f"{self._base_url}{_MINT_TOKEN_PATH}",
                json=body,
                headers=await self._auth_headers(),
                timeout=_MINT_TOKEN_TIMEOUT_S,
                # Per-call, so an injected client built with
                # ``follow_redirects=True`` cannot follow one before the
                # check below sees it.
                follow_redirects=False,
            )
        except httpx.HTTPError as exc:
            raise MintTokenError(code=MintTokenErrorCode.REQUEST_FAILED, message=str(exc)) from exc
        if response.is_redirect:
            # Refused rather than followed: the workspace api key rides on
            # this request, and a redirect could re-send it to another origin.
            target = response.headers.get("location")
            raise MintTokenError(
                code=MintTokenErrorCode.REQUEST_FAILED,
                message=(
                    f"Mint-token endpoint redirected (HTTP {response.status_code}"
                    + (f" → {target}" if target else "")
                    + "); redirects are refused so the credential cannot leave "
                    "the configured origin."
                ),
            )
        if response.status_code >= 400:
            code, message = _parse_error_detail(response)
            logger.warning(
                "realtime.mint_token_rejected",
                status_code=response.status_code,
                code=code,
            )
            raise MintTokenError(code=MintTokenErrorCode.REQUEST_REJECTED, message=message, server_code=code)
        try:
            payload = response.json()
        except ValueError as exc:
            raise MintTokenError(
                code=MintTokenErrorCode.INVALID_RESPONSE,
                message="Mint-token response was not JSON.",
            ) from exc
        minted = parse_minted_token(payload)
        if minted is None:
            raise MintTokenError(
                code=MintTokenErrorCode.INVALID_RESPONSE,
                message="Mint-token response missing jwt / expires_at.",
            )
        return minted

    def _assemble_config(
        self,
        *,
        name: str | None,
        inputs: Mapping[str, str] | None,
        instructions: str | None,
        model: RealtimeModel | None,
        voice: str | VoiceConfig | None,
        tools: Sequence[AgentTool] | None,
        interruption_sensitivity: InterruptionSensitivity | None,
        audio: AudioConfig | None,
        resume_session_id: UUID | str | None,
        greeting: str | None = None,
        store_recording: bool | None = None,
        store_audio: bool | None = None,
        store_transcript: bool | None = None,
        store_video: bool | None = None,
        server_hooks: Sequence[ServerHook] | None = None,
    ) -> SessionConfig:
        """Build the ``session-config`` payload from already-resolved persona
        (``agent``) and per-run (``session``) fields. Any ``None`` is omitted
        so the protocol's server-side default applies."""
        if tools is not None:
            assert_no_reserved_tool_names(tools)
        if isinstance(voice, str):
            voice = VoiceConfig(name=voice)
        session_values: dict[str, Any] = {}
        for key, value in (
            ("store_recording", store_recording),
            ("store_audio", store_audio),
            ("store_transcript", store_transcript),
            ("store_video", store_video),
        ):
            if value is not None:
                session_values[key] = value
        if resume_session_id is not None:
            session_values["experimental"] = ExperimentalParams(
                resume_session_id=UUID(str(resume_session_id))
            )

        if name is not None:
            stored = {
                "instructions": instructions,
                "model": model,
                "interruption_sensitivity": interruption_sensitivity,
                "audio": audio,
                "greeting": greeting,
                "hooks": server_hooks,
            }
            offending = sorted(k for k, v in stored.items() if v is not None)
            if offending:
                raise ValueError(
                    "a catalog agent runs its stored config verbatim — remove "
                    f"the stored-config field(s): {', '.join(offending)}"
                )
            catalog_values: dict[str, Any] = {"name": name}
            if inputs is not None:
                catalog_values["inputs"] = dict(inputs)
            if voice is not None:
                catalog_values["voice"] = voice
            if tools is not None:
                catalog_values["tools"] = list(tools)
            return SessionConfig(
                sdk=_sdk_info(),
                agent=CatalogAgentConfig(**catalog_values),
                session=SessionParams(**session_values),
            )

        agent_values: dict[str, Any] = {}
        if instructions is not None:
            agent_values["instructions"] = instructions
        if model is not None:
            agent_values["model"] = model
        if voice is not None:
            agent_values["voice"] = voice
        if tools is not None:
            agent_values["tools"] = list(tools)
        if interruption_sensitivity is not None:
            agent_values["interruption_sensitivity"] = interruption_sensitivity
        if audio is not None:
            agent_values["audio"] = audio
        if server_hooks is not None:
            agent_values["hooks"] = list(server_hooks)
        if greeting is not None:
            agent_values["greeting"] = greeting
        return SessionConfig(
            sdk=_sdk_info(),
            agent=InlineAgentConfig(**agent_values),
            session=SessionParams(**session_values),
        )

    async def _start_session(
        self, config: SessionConfig, prepared: PreparedRoom | None = None
    ) -> StartedSession:
        """Start a session on this client's lane."""
        if self._transport == "websocket":
            return await self._post_ws_session_start(config)
        return await self._post_session_start(config, prepared)

    async def _prepare_room(self) -> PreparedRoom | None:
        """POST ``session/prepare-room``. Best-effort by design: any failure
        logs and returns ``None``, leaving the start on the ordinary path."""
        try:
            response = await self._http().post(
                f"{self._base_url}{_PREPARE_ROOM_PATH}",
                json={},
                headers=await self._auth_headers(),
                timeout=_SESSION_START_TIMEOUT_S,
            )
            if response.status_code >= 400:
                code, _ = _parse_error_detail(response)
                logger.debug(
                    "realtime.prepare_room_rejected",
                    status_code=response.status_code,
                    code=code,
                )
                return None
            body = response.json()
            prepared = PreparedRoom(
                livekit_url=body["livekit_url"],
                token=body["token"],
                room_name=body["room_name"],
                room_grant=body["room_grant"],
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.debug("realtime.prepare_room_failed", error=str(exc))
            return None
        logger.debug("realtime.room_prepared", room_name=prepared.room_name)
        return prepared

    async def _post_ws_session_start(
        self, config: SessionConfig
    ) -> WsSessionStart:
        """Start on a self-hosted server's websocket transport.

        Its own route because it answers a socket rather than a room and a
        join token — Cosmo's managed deployment does not serve it, and the
        published start contract stays what the managed deployment answers.
        """
        body = config.model_dump(mode="json", exclude_none=True, exclude={"id"})
        headers = await self._auth_headers()
        try:
            response = await self._http().post(
                f"{self._base_url}{_SESSION_WS_START_PATH}",
                json=body,
                headers=headers,
                timeout=_SESSION_START_TIMEOUT_S,
            )
        except httpx.HTTPError as exc:
            raise SessionStartError(code=SessionStartErrorCode.TRANSPORT, message=str(exc)) from exc
        if response.status_code == 404:
            raise SessionStartError(
                code=SessionStartErrorCode.CONFIG,
                message=(
                    f"{self._base_url} does not serve the websocket transport; "
                    "start cosmo-server with COSMO_TRANSPORT=websocket, or drop "
                    "transport=\"websocket\" to use the WebRTC room transport"
                ),
                status=404,
            )
        if response.status_code >= 400:
            code, message = _parse_error_detail(response)
            logger.warning(
                "realtime.session_start_rejected",
                status_code=response.status_code,
                code=code,
            )
            if response.status_code == 401 and self._token_source is not None:
                # Same reason as the room path, and likelier here: a
                # self-hosted server generates a signing key at startup, so a
                # restart invalidates every token minted before it.
                self._token_source._invalidate()
            raise SessionStartError(
                code=_classify_start_rejection(code, response.status_code),
                message=message,
                status=response.status_code,
                server_code=code,
                retry_after_seconds=_retry_after_seconds(response),
                detail=_rejection_detail(response),
            )
        try:
            started = WsSessionStart.model_validate(response.json())
        except (ValidationError, ValueError) as exc:
            raise SessionStartError(
                code=SessionStartErrorCode.INVALID_RESPONSE, message=str(exc)
            ) from exc
        return started

    async def _post_session_start(
        self, config: SessionConfig, prepared: PreparedRoom | None = None
    ) -> SessionResponse:
        body = config.model_dump(mode="json", exclude_none=True, exclude={"id"})
        headers = await self._auth_headers()
        if prepared is not None:
            headers["x-cosmo-prepared-room-name"] = prepared.room_name
            headers["x-cosmo-prepared-room-grant"] = prepared.room_grant
        try:
            response = await self._http().post(
                f"{self._base_url}{_SESSION_START_PATH}",
                json=body,
                headers=headers,
                timeout=_SESSION_START_TIMEOUT_S,
            )
        except httpx.HTTPError as exc:
            raise SessionStartError(code=SessionStartErrorCode.TRANSPORT, message=str(exc)) from exc
        if response.status_code >= 400:
            code, message = _parse_error_detail(response)
            logger.warning(
                "realtime.session_start_rejected",
                status_code=response.status_code,
                code=code,
            )
            if response.status_code == 401 and self._token_source is not None:
                # The fetched token was rejected despite the refresh skew
                # (revoked, or clocks disagree): drop it so the next start
                # fetches fresh.
                self._token_source._invalidate()
            raise SessionStartError(
                code=_classify_start_rejection(code, response.status_code),
                message=message,
                status=response.status_code,
                server_code=code,
                retry_after_seconds=_retry_after_seconds(response),
                detail=_rejection_detail(response),
            )
        try:
            return SessionResponse.model_validate(response.json())
        except (ValidationError, ValueError) as exc:
            raise SessionStartError(
                code=SessionStartErrorCode.INVALID_RESPONSE, message=str(exc)
            ) from exc

    async def _post_dial(
        self,
        session_id: str,
        phone_number: str,
        caller_number: Optional[str] = None,
    ) -> DialResult:
        path = f"{_SESSION_PATH}/{session_id}/dial"
        body: dict[str, str] = {"phone_number": phone_number}
        if caller_number is not None:
            body["caller_number"] = caller_number
        try:
            response = await self._http().post(
                f"{self._base_url}{path}",
                json=body,
                headers=await self._auth_headers(),
                timeout=_SESSION_START_TIMEOUT_S,
            )
        except httpx.HTTPError as exc:
            raise DialError(code=DialErrorCode.REQUEST_FAILED, message=str(exc)) from exc
        if response.status_code >= 400:
            code, message = _parse_error_detail(response)
            logger.warning(
                "realtime.dial_rejected",
                status_code=response.status_code,
                code=code,
            )
            raise DialError(code=DialErrorCode.REQUEST_REJECTED, message=message, server_code=code)
        try:
            result = DialResult.model_validate(response.json())
        except (ValidationError, ValueError) as exc:
            raise DialError(code=DialErrorCode.INVALID_RESPONSE, message=str(exc)) from exc
        logger.info(
            "realtime.dial_succeeded",
            session_id=session_id,
            dial_id=str(result.dial_id),
        )
        return result

    async def get_session_usage(self, session_id: str) -> SessionUsage:
        """Fetch a session's usage summary: duration, talk time, and token
        counts in provider-reported units.

        Takes an explicit session id because the client outlives any one
        session — :meth:`RealtimeSession.usage` is the id-carrying surface,
        and this is how a process that no longer holds the session (a later
        run, a billing job, a crash recovery) reads the same numbers.

        Raises :class:`UsageError` if the server rejects the request, the
        transport fails, or the response cannot be parsed.
        """
        path = f"{_SESSIONS_PATH}/{session_id}/usage"
        try:
            response = await self._http().get(
                f"{self._base_url}{path}",
                headers=await self._auth_headers(),
                timeout=_SESSION_START_TIMEOUT_S,
            )
        except httpx.HTTPError as exc:
            raise UsageError(code=UsageErrorCode.REQUEST_FAILED, message=str(exc)) from exc
        if response.status_code >= 400:
            code, message = _parse_error_detail(response)
            logger.warning(
                "realtime.usage_rejected",
                session_id=session_id,
                status_code=response.status_code,
                code=code,
            )
            raise UsageError(code=UsageErrorCode.REQUEST_REJECTED, message=message, server_code=code)
        try:
            return SessionUsage.model_validate(response.json())
        except (ValidationError, ValueError) as exc:
            raise UsageError(code=UsageErrorCode.INVALID_RESPONSE, message=str(exc)) from exc

    async def _auth_headers(self) -> dict[str, str]:
        """Per-request auth + SDK identity, so a caller-supplied
        ``http_client`` doesn't need to know either (and we never mutate
        someone else's client)."""
        headers = {"X-Cosmo-SDK": f"{SDK_NAME}/{SDK_VERSION}"}
        if self._token_source is not None:
            headers["Authorization"] = f"Bearer {await self._token_source._get_jwt()}"
        else:
            assert self._credential is not None  # constructor sets exactly one
            headers["Authorization"] = f"Bearer {self._credential.get_secret_value()}"
        return headers

    def _http(self) -> httpx.AsyncClient:
        if self._http_client is None:
            self._http_client = httpx.AsyncClient(timeout=_SESSION_START_TIMEOUT_S)
        return self._http_client

    async def aclose(self) -> None:
        """Release the HTTP resources this client owns. Idempotent, and the
        same thing ``async with`` does on exit.

        This ends nothing on the server. Sessions outlive the client that
        started them, so a live one is ended through the session itself —
        :meth:`RealtimeSession.end` to tear it down server-side, or
        :meth:`RealtimeSession.close` to drop the local half and leave it
        running.

        An ``http_client`` you passed in is left open: you own its lifecycle.
        """
        # Only close a client we created; a caller-supplied one is theirs.
        if self._owns_http_client and self._http_client is not None:
            await self._http_client.aclose()
            self._http_client = None

    async def __aenter__(self) -> "RealtimeClient":
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        await self.aclose()


class _PostSessionStart(Protocol):
    """The client's session-start call; ``prepared`` rides as headers."""

    def __call__(
        self, config: SessionConfig, prepared: PreparedRoom | None = None
    ) -> Awaitable[StartedSession]: ...


class SessionHandle:
    """Return value of :meth:`RealtimeAgent.start`: an awaitable that is also an async
    context manager, either form yielding the started :class:`RealtimeSession`.
    Created by the SDK — there is no reason to construct one yourself. Connects
    MCP servers (if any) at open, merges their tools into the session config,
    and binds their teardown to the session."""

    def __init__(
        self,
        post_session_start: _PostSessionStart,
        post_dial: PostDial,
        get_usage: GetUsage,
        build_config: Callable[
            [tuple[AgentTool, ...]],
            SessionConfig,
        ],
        base_tools: tuple[AgentTool, ...],
        mcp: tuple[McpStdioServer, ...] | None,
        on_state_change: OnStateChange | None,
        hooks: HookEngine | None = None,
        transport: TransportName = "webrtc",
        take_prepared: Callable[[], Awaitable[PreparedRoom | None]] | None = None,
    ) -> None:
        self._post_session_start = post_session_start
        self._transport = transport
        self._take_prepared = take_prepared
        self._post_dial = post_dial
        self._get_usage = get_usage
        self._build_config = build_config
        self._base_tools = base_tools
        self._mcp = mcp
        self._on_state_change = on_state_change
        self._hooks = hooks
        self._session: RealtimeSession | None = None

    async def _open(self) -> RealtimeSession:
        connected: ConnectedMcp | None = None
        if self._mcp is not None:
            # Zero-config server opt-ins carry no name — only the named
            # tools can collide with MCP tool names.
            reserved_names = frozenset(
                t.name
                for t in self._base_tools
                if isinstance(t, ClientTool)
            )
            connected = await connect_mcp(
                self._mcp,
                reserved_names=reserved_names, reserved_count=len(self._base_tools)
            )
        try:
            extra = tuple(connected.tools) if connected is not None else ()
            config = self._build_config(self._base_tools + extra)
            session = RealtimeSession(
                config=config,
                on_state_change=self._on_state_change,
                post_dial=self._post_dial,
                get_usage=self._get_usage,
                on_close=connected.aclose if connected is not None else None,
                hooks=self._hooks,
                transport=self._transport,
            )
            started_at = time.perf_counter()
            prepared = (
                await self._take_prepared() if self._take_prepared is not None else None
            )
            if prepared is None:
                return await session._start(
                    self._post_session_start, started_at=started_at
                )
            # Bind the room ref here so the engine keeps its one-argument
            # start contract; the headers ride only the bound call, and the
            # unbound one stays available for the rejected-start retry.
            post, prepared_ref = self._post_session_start, prepared

            async def _start_with_prepared(config: SessionConfig) -> StartedSession:
                return await post(config, prepared_ref)

            return await session._start(
                self._post_session_start,
                prepared_ref,
                _start_with_prepared,
                started_at=started_at,
            )
        except BaseException:
            if connected is not None:
                await connected.aclose()
            raise

    def __await__(self) -> Generator[Any, None, RealtimeSession]:
        return self._open().__await__()

    async def __aenter__(self) -> RealtimeSession:
        self._session = await self._open()
        return self._session

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        if self._session is not None:
            await self._session.end()


@dataclass(frozen=True)
class RealtimeAgent:
    """The persona/configuration of the model on the other end — instructions,
    model, voice, tools, and turn-taking behavior — reusable across any number
    of sessions.

    Immutable; build one with :meth:`RealtimeClient.agent`. Open a live run
    with :meth:`start`, which carries the per-run, transport-level options.
    """

    _client: "RealtimeClient" = field(repr=False, compare=False)
    name: str | None = None
    """Catalog handle this agent runs, for one built by
    :meth:`RealtimeClient.catalog_agent`. ``None`` for an inline agent."""
    inputs: Mapping[str, str] | None = None
    """Values for a catalog agent's declared input fields. ``None`` for an
    inline agent, which has no stored prompt to fill in."""
    instructions: str | None = None
    """System instructions as given. ``None`` means the server's default
    runs — this never reads back the server's own text."""
    model: RealtimeModel | None = None
    """What was requested, verbatim: the alias or id string, or the provider
    block. ``None`` leaves the choice to the server, and this does not tell
    you what it chose — read :attr:`SessionUsage.model` after the fact."""
    voice: str | VoiceConfig | None = None
    """The voice as given, string or :class:`VoiceConfig`."""
    tools: tuple[AgentTool, ...] | None = None
    """Every tool this agent may call, in declaration order."""
    interruption_sensitivity: InterruptionSensitivity | None = None
    """Barge-in setting as given."""
    greeting: str | None = None
    """Opening line, if one was set."""
    audio: AudioConfig | None = None
    """Audio pipeline settings as given."""
    mcp: tuple[McpStdioServer, ...] | None = None
    """MCP servers after resolution — config-file paths are expanded here, so
    this is the flat list that will actually be launched."""
    skills: tuple[Skill, ...] | None = None
    """Skills after resolution — directories are expanded, so this is the
    flat list with each skill's frontmatter already parsed."""
    hooks: tuple[Hook | ServerHook, ...] | None = None
    """Hooks as declared, both kinds in one tuple: :class:`Hook` runs
    in-process here, :class:`ServerHook` is sent for the server to run."""

    def start(
        self,
        *,
        resume_session_id: UUID | str | None = None,
        store_recording: bool | None = None,
        store_audio: bool | None = None,
        store_transcript: bool | None = None,
        store_video: bool | None = None,
        on_state_change: OnStateChange | None = None,
    ) -> "SessionHandle":
        """Start one live session for this agent.

        The arguments are the per-run, transport-level concerns:
        ``resume_session_id`` (continue a prior session), the storage opt-outs
        (``store_recording`` for the whole run, or ``store_audio`` /
        ``store_transcript`` / ``store_video`` per artifact — each narrowing
        only, so a run may store less than the account's consents allow but
        never more), and ``on_state_change`` (observe this run's lifecycle). The
        agent's persona fields — including its ``greeting`` and
        ``audio`` pipeline — are sent unchanged on every session; build
        another agent to change them. A session that will
        :meth:`RealtimeSession.dial` a number in needs no special start flag.

        The canonical form is the async context manager, which ends the
        session on exit::

            async with agent.start() as session:
                async for event in session:
                    ...

        It is also awaitable when you want to own the lifecycle yourself
        (call ``session.end()`` when done)::

            session = await agent.start()

        Raises :class:`SessionStartError` with ``VERSION_MISMATCH`` when the server refuses the
        protocol version and :class:`SessionStartError` for any other
        rejection.
        """
        return self._session_handle(
            resume_session_id=resume_session_id,
            store_recording=store_recording,
            store_audio=store_audio,
            store_transcript=store_transcript,
            store_video=store_video,
            on_state_change=on_state_change,
        )

    def prepare_session(
        self,
        *,
        resume_session_id: UUID | str | None = None,
        store_recording: bool | None = None,
        store_audio: bool | None = None,
        store_transcript: bool | None = None,
        store_video: bool | None = None,
        on_state_change: OnStateChange | None = None,
    ) -> "PreparedSession":
        """Prepare one session ahead of its start, so it starts faster.

        Reserves a room in the background immediately; the returned
        :class:`PreparedSession` joins it while the session request is still
        in flight when you call :meth:`PreparedSession.start`, instead of
        waiting for a room to be allocated. Prepare as early as the app knows
        a session is coming — while the rest of its setup runs — and start
        when the user is ready. The arguments are the same per-run options
        :meth:`start` takes; they are fixed here, and the start takes none.

        Purely an accelerator: a reservation that failed, lapsed, or is
        declined by the server leaves the start on the ordinary path, with the
        same result as :meth:`start`. Needs a running event loop and the
        ``webrtc`` transport (the ``websocket`` lane has no rooms to prepare).
        """
        return PreparedSession(
            self,
            resume_session_id=resume_session_id,
            store_recording=store_recording,
            store_audio=store_audio,
            store_transcript=store_transcript,
            store_video=store_video,
            on_state_change=on_state_change,
        )

    def _session_handle(
        self,
        *,
        resume_session_id: UUID | str | None,
        store_recording: bool | None,
        store_audio: bool | None,
        store_transcript: bool | None,
        store_video: bool | None,
        on_state_change: OnStateChange | None,
        take_prepared: Callable[[], Awaitable[PreparedRoom | None]] | None = None,
    ) -> "SessionHandle":
        client = self._client
        client_hooks = server_hooks = None
        if self.hooks is not None:
            client_hooks = [h for h in self.hooks if isinstance(h, Hook)]
            server_hooks = [h for h in self.hooks if isinstance(h, ServerHook)]
        instructions = self.instructions
        base_tools: tuple[AgentTool, ...] = self.tools or ()
        if self.skills is not None:
            load_tool = build_load_skill_tool(self.skills)
            if load_tool is not None:
                menu = menu_text(self.skills)
                instructions = f"{instructions}\n\n{menu}" if instructions else menu
                base_tools = (*base_tools, load_tool)

        def build_config(
            all_tools: tuple[AgentTool, ...],
        ) -> SessionConfig:
            return client._assemble_config(
                name=self.name,
                inputs=self.inputs,
                instructions=instructions,
                model=self.model,
                voice=self.voice,
                tools=all_tools or None,
                interruption_sensitivity=self.interruption_sensitivity,
                audio=self.audio,
                resume_session_id=resume_session_id,
                greeting=self.greeting,
                store_recording=store_recording,
                store_audio=store_audio,
                store_transcript=store_transcript,
                store_video=store_video,
                server_hooks=server_hooks or None,
            )

        return SessionHandle(
            client._start_session,
            client._post_dial,
            client.get_session_usage,
            build_config,
            base_tools,
            self.mcp,
            on_state_change,
            hooks=HookEngine(client_hooks) if client_hooks is not None else None,
            transport=client._transport,
            take_prepared=take_prepared,
        )


class PreparedSession:
    """One session prepared ahead of its start: a room reserved in the
    background that :meth:`start` joins while the session request is still
    in flight. Build one with :meth:`RealtimeAgent.prepare_session`, which
    documents the arguments.

    The reservation is refreshed in the background until the handle is
    started or closed, so one held for hours stays warm. :meth:`start` is
    single-use — prepare another session for another start — and a handle
    that will never be started should be :meth:`close`\\ d so the refresh
    stops.
    """

    def __init__(
        self,
        agent: RealtimeAgent,
        *,
        resume_session_id: UUID | str | None = None,
        store_recording: bool | None = None,
        store_audio: bool | None = None,
        store_transcript: bool | None = None,
        store_video: bool | None = None,
        on_state_change: OnStateChange | None = None,
    ) -> None:
        client = agent._client
        if client._transport == "websocket":
            raise ValueError(
                "prepare_session needs the webrtc transport; the websocket lane "
                "has no rooms to prepare"
            )
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            raise RuntimeError(
                "prepare_session must be called from a running event loop"
            ) from None
        self._agent = agent
        self._reserve = client._prepare_room
        self._run_options: dict[str, Any] = {
            "resume_session_id": resume_session_id,
            "store_recording": store_recording,
            "store_audio": store_audio,
            "store_transcript": store_transcript,
            "store_video": store_video,
            "on_state_change": on_state_change,
        }
        self._room: PreparedRoom | None = None
        self._started = False
        self._closed = False
        self._taken = False
        self._inflight: asyncio.Future[PreparedRoom | None] = asyncio.ensure_future(
            self._reserve()
        )
        self._refresh = loop.create_task(self._keep_reserved())

    async def _keep_reserved(self) -> None:
        """Land the reservation, then renew it before the room lapses; one the
        server declines ends the refresh and the start runs ordinarily."""
        while True:
            # Shielded: a take cancels this loop but still wants the room the
            # in-flight reservation is about to produce.
            room = await asyncio.shield(self._inflight)
            if room is None:
                return
            self._room = room
            await asyncio.sleep(PREPARED_ROOM_REFRESH_S)
            self._inflight = asyncio.ensure_future(self._reserve())

    def start(self) -> SessionHandle:
        """Start the prepared session: an awaitable that is also an async
        context manager, exactly as :meth:`RealtimeAgent.start` returns::

            async with prepared.start() as session:
                ...

        Raises :class:`SessionStartError`
        as :meth:`RealtimeAgent.start` does, and ``RuntimeError`` on a second
        call — the handle is single-use, and so is the handle it returns.
        """
        if self._started or self._closed:
            raise RuntimeError(
                "PreparedSession.start is single-use; prepare another session"
            )
        self._started = True
        # Stopped here, not at the take: the take runs after the session's
        # own setup, and a setup that fails must not leave a refresh behind.
        self._refresh.cancel()
        return self._agent._session_handle(take_prepared=self._take, **self._run_options)

    async def _take(self) -> PreparedRoom | None:
        """Hand the reserved room to the start, waiting for a reservation
        still in flight. Stale rooms are dropped; a second take raises."""
        if self._taken:
            raise RuntimeError(
                "PreparedSession.start is single-use; prepare another session"
            )
        self._taken = True
        room = (await self._inflight) or self._room
        self._room = None
        if room is not None and room.is_stale():
            logger.debug("realtime.prepared_room_stale", room_name=room.room_name)
            return None
        return room

    async def close(self) -> None:
        """Drop the reservation and stop refreshing it. A no-op once started:
        the start owns the reservation from then on."""
        if self._started:
            return
        self._closed = True
        self._refresh.cancel()
        with contextlib.suppress(BaseException):
            await self._refresh
        self._inflight.cancel()
        with contextlib.suppress(BaseException):
            await self._inflight
        self._room = None


def _clean_credential(raw: str) -> str:
    """The credential as it can be sent, or a named error.

    A key read from a file or an environment variable arrives with what the
    tool that wrote it left behind: a trailing newline from a shell
    redirect, a byte-order mark from PowerShell's UTF-8. Those are trimmed.
    Anything still outside printable ASCII cannot go in an Authorization
    header, and httpx raises from inside the request when it tries — a
    UnicodeEncodeError or "Illegal header value", outside the error family
    a caller catches. Refuse it here instead, as the other unusable
    credentials are refused.
    """
    cleaned = raw.strip().strip("﻿").strip()
    if not cleaned:
        raise CredentialsError(
            code=CredentialsErrorCode.MALFORMED_CREDENTIAL,
            message="the credential is empty once whitespace is trimmed",
        )
    bad = next((c for c in cleaned if not (0x21 <= ord(c) <= 0x7E)), None)
    if bad is not None:
        raise CredentialsError(
            code=CredentialsErrorCode.MALFORMED_CREDENTIAL,
            message=f"the credential contains {bad!r}, which an Authorization "
            "header cannot carry — check for a stray character in the value",
        )
    return cleaned


_TRANSPORT_NAMES: tuple[str, ...] = ("webrtc", "websocket", "livekit")


def _resolve_transport(
    transport: "TransportName | None",
) -> "TransportName":
    """The lane this client runs on: the argument, then ``COSMO_TRANSPORT``,
    then the room transport Cosmo serves.

    An unrecognized name is refused rather than defaulted. Everything that is
    not exactly ``"websocket"`` runs the room lane, so a typo would otherwise
    post to the wrong endpoint and read as a server problem."""
    if transport is None:
        # Unset is the room lane. An empty environment variable is unset too;
        # an empty argument is a caller who meant something and got it wrong.
        named = (os.environ.get(_TRANSPORT_ENV_VAR) or "").strip().lower()
        if not named:
            return "webrtc"
        source = _TRANSPORT_ENV_VAR
    else:
        named = transport
        source = "transport"
    if named not in _TRANSPORT_NAMES:
        raise ValueError(f"{source} must be webrtc or websocket, got {named!r}")
    if named == "livekit":
        warnings.warn(
            "transport='livekit' is deprecated; use transport='webrtc'",
            DeprecationWarning,
            stacklevel=3,
        )
        return "webrtc"
    return "websocket" if named == "websocket" else "webrtc"


def _parse_error_detail(response: httpx.Response) -> tuple[str, str]:
    """Extract the server's typed ``(code, message)`` rejection; fall back to a
    synthetic ``http_<status>`` code.

    The external API (the surface this SDK talks to) wraps every error as
    ``{"error": {"type", "code"?, "message"}}`` — ``code`` carries the typed
    rejection slug and ``message`` is always a string; when ``code`` is absent
    (auth / validation errors) the error ``type`` is the closest thing to a
    slug. Two legacy shapes are still read for skew against older backends:
    the pre-flattening envelope that nested ``{code, message}`` inside
    ``message``, and the internal ``{"detail": ...}`` shape.
    """
    fallback_code = f"http_{response.status_code}"
    try:
        payload = response.json()
    except ValueError:
        return fallback_code, response.text[:500]
    if not isinstance(payload, dict):
        return fallback_code, response.text[:500]

    error = payload.get("error")
    if isinstance(error, dict):
        message = error.get("message")
        code = error.get("code")
        if isinstance(code, str) and isinstance(message, str):
            return code, message
        if isinstance(message, dict) and "code" in message:
            return str(message["code"]), str(message.get("message", ""))
        if isinstance(message, str):
            return str(error.get("type") or fallback_code), message
        return str(error.get("type") or fallback_code), response.text[:500]

    detail = payload.get("detail")
    if isinstance(detail, dict) and "code" in detail:
        return str(detail["code"]), str(detail.get("message", ""))
    if isinstance(detail, str):
        return fallback_code, detail
    if isinstance(detail, list) and detail:
        return "invalid_session_config", _format_validation_errors(detail)

    return fallback_code, response.text[:500]


def _rejection_detail(response: httpx.Response) -> SessionStartRejection | None:
    """The server's structured rejection body, or ``None`` when it sent none.

    Reads the same two shapes as ``_parse_error_detail`` — the external
    ``{"error": {...}}`` envelope and the internal ``{"detail": {...}}`` — and
    keeps every field, including ones this SDK does not name.
    """
    try:
        payload = response.json()
    except ValueError:
        return None
    if not isinstance(payload, dict):
        return None
    for body in (payload.get("error"), payload.get("detail")):
        if isinstance(body, dict) and body.get("code"):
            return SessionStartRejection._from_body(body)
    return None


_MAX_RENDERED_VALIDATION_ERRORS = 5


def _format_validation_errors(entries: list[Any]) -> str:
    """Render FastAPI's request-validation ``detail`` array as one line naming
    the fields that failed, rather than dumping the raw payload. The field path
    is the whole diagnosis — most often a client newer than the backend it is
    talking to, sending a field that backend has no model for."""
    rendered: list[str] = []
    for entry in entries[:_MAX_RENDERED_VALIDATION_ERRORS]:
        if not isinstance(entry, dict):
            rendered.append(str(entry))
            continue
        loc = list(entry.get("loc") or [])
        if loc and loc[0] == "body":
            loc = loc[1:]
        path = ".".join(str(part) for part in loc)
        msg = str(entry.get("msg") or "is invalid")
        rendered.append(f"{path}: {msg}" if path else msg)
    omitted = len(entries) - len(rendered)
    if omitted > 0:
        rendered.append(f"(+{omitted} more)")
    return "; ".join(rendered)
