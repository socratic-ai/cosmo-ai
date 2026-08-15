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
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Generator, Mapping, Optional, Sequence
from urllib.parse import urlparse
from uuid import UUID

import httpx
import structlog
from pydantic import SecretStr, ValidationError

from cosmo_ai._internal.logging import get_logger
from cosmo_ai.errors import (
    DialError,
    MintTokenError,
    SessionStartError,
    UsageError,
    VerifyError,
    VersionMismatchError,
)
from cosmo_ai._internal.hooks import Hook, HookEngine, resolve_hooks
from cosmo_ai.mcp._engine import ConnectedMcp, McpInput, McpStdioServer, connect_mcp, resolve_mcp
from cosmo_ai._internal.protocol import (
    SDK_NAME,
    SDK_VERSION,
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
    RealtimeModelOptions,
    ServerHook,
    VoiceConfig,
    SessionUsage,
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
from cosmo_ai.token_source import TokenSource
from cosmo_ai.tools._sdk_tools import assert_no_reserved_tool_names

logger: structlog.stdlib.BoundLogger = get_logger(__name__)

_SESSION_PATH = "/api/v1/external/realtime/session"
_SESSION_START_PATH = f"{_SESSION_PATH}/start"
_MINT_TOKEN_PATH = "/api/v1/external/auth/token"
_VERIFY_PATH = "/api/v1/external/realtime/verify"
_SESSIONS_PATH = "/api/v1/external/sessions"
_SESSION_START_TIMEOUT_S = 40.0
_LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
_DEFAULT_BASE_URL = "https://platform.askcosmo.ai"
_BASE_URL_ENV_VAR = "COSMO_BASE_URL"


def _as_tuple(
    tools: Sequence[AgentTool] | None,
) -> tuple[AgentTool, ...] | None:
    return tuple(tools) if tools is not None else None


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
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        if api_key is not None and token is not None:
            raise ValueError("provide at most one of api_key or token")
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
            self._credential = SecretStr(credential)
        base_url = (
            resolved_base_url
            or (os.environ.get(_BASE_URL_ENV_VAR) or "").strip()
            or _DEFAULT_BASE_URL
        )
        self._base_url = base_url.rstrip("/")
        parsed = urlparse(self._base_url)
        if parsed.scheme != "https" and parsed.hostname not in _LOCAL_HOSTS:
            raise ValueError(
                f"{_BASE_URL_ENV_VAR} must use https:// (http is allowed only for localhost)"
            )
        self._http_client: httpx.AsyncClient | None = http_client
        self._owns_http_client = http_client is None

    def agent(
        self,
        *,
        instructions: str | None = None,
        model: str | None = None,
        model_options: RealtimeModelOptions | None = None,
        voice: str | VoiceConfig | None = None,
        tools: Sequence[AgentTool] | None = None,
        interruption_sensitivity: InterruptionSensitivity | None = None,
        greeting: str | None = None,
        audio: AudioConfig | None = None,
        mcp: McpInput | None = None,
        skills: SkillsInput | None = None,
        hooks: Sequence[Hook | ServerHook] | None = None,
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
        :class:`~cosmo_ai.skills.SkillParseError` here, not mid-call. A
        directory that yields no skills warns and attaches none.

        Fields left ``None`` fall back to the protocol's server-side defaults
        — ``audio.noise_cancellation`` among them, which is off; pass
        ``AudioConfig(noise_cancellation=True)`` when the microphone will
        hear more than one voice. Open a live run with :meth:`RealtimeAgent.start`.
        """
        return RealtimeAgent(
            _client=self,
            instructions=instructions,
            model=model,
            model_options=model_options,
            voice=voice,
            tools=_as_tuple(tools),
            interruption_sensitivity=interruption_sensitivity,
            greeting=greeting,
            audio=audio,
            mcp=resolve_mcp(mcp),
            skills=resolve_skills(skills),
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
            raise VerifyError(code="transport_error", message=str(exc)) from exc
        if response.status_code >= 400:
            code, message = _parse_error_detail(response)
            logger.warning(
                "realtime.verify_rejected",
                status_code=response.status_code,
                code=code,
            )
            raise VerifyError(code=code, message=message)
        try:
            return CredentialInfo.model_validate(response.json())
        except (ValidationError, ValueError) as exc:
            raise VerifyError(code="invalid_response", message=str(exc)) from exc

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
                code="no_api_key",
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
                timeout=_SESSION_START_TIMEOUT_S,
            )
        except httpx.HTTPError as exc:
            raise MintTokenError(code="transport_error", message=str(exc)) from exc
        if response.status_code >= 400:
            code, message = _parse_error_detail(response)
            logger.warning(
                "realtime.mint_token_rejected",
                status_code=response.status_code,
                code=code,
            )
            raise MintTokenError(code=code, message=message)
        try:
            return MintedToken.model_validate(response.json())
        except (ValidationError, ValueError) as exc:
            raise MintTokenError(code="invalid_response", message=str(exc)) from exc

    def _assemble_config(
        self,
        *,
        name: str | None,
        inputs: Mapping[str, str] | None,
        instructions: str | None,
        model: str | None,
        model_options: RealtimeModelOptions | None,
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
                "model_options": model_options,
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
                agent=CatalogAgentConfig(**catalog_values),
                session=SessionParams(**session_values),
            )

        agent_values: dict[str, Any] = {}
        if instructions is not None:
            agent_values["instructions"] = instructions
        if model is not None:
            agent_values["model"] = model
        if model_options is not None:
            agent_values["model_options"] = model_options
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
            agent=InlineAgentConfig(**agent_values),
            session=SessionParams(**session_values),
        )

    async def _post_session_start(
        self, config: SessionConfig
    ) -> SessionResponse:
        body = config.model_dump(mode="json", exclude_none=True)
        try:
            response = await self._http().post(
                f"{self._base_url}{_SESSION_START_PATH}",
                json=body,
                headers=await self._auth_headers(),
                timeout=_SESSION_START_TIMEOUT_S,
            )
        except httpx.HTTPError as exc:
            raise SessionStartError(code="transport_error", message=str(exc)) from exc
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
            if code == "version_mismatch":
                raise VersionMismatchError(code=code, message=message)
            raise SessionStartError(code=code, message=message)
        try:
            return SessionResponse.model_validate(response.json())
        except (ValidationError, ValueError) as exc:
            raise SessionStartError(code="invalid_response", message=str(exc)) from exc

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
            raise DialError(code="transport_error", message=str(exc)) from exc
        if response.status_code >= 400:
            code, message = _parse_error_detail(response)
            logger.warning(
                "realtime.dial_rejected",
                status_code=response.status_code,
                code=code,
            )
            raise DialError(code=code, message=message)
        try:
            result = DialResult.model_validate(response.json())
        except (ValidationError, ValueError) as exc:
            raise DialError(code="invalid_response", message=str(exc)) from exc
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
            raise UsageError(code="transport_error", message=str(exc)) from exc
        if response.status_code >= 400:
            code, message = _parse_error_detail(response)
            logger.warning(
                "realtime.usage_rejected",
                session_id=session_id,
                status_code=response.status_code,
                code=code,
            )
            raise UsageError(code=code, message=message)
        try:
            return SessionUsage.model_validate(response.json())
        except (ValidationError, ValueError) as exc:
            raise UsageError(code="invalid_response", message=str(exc)) from exc

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
        # Only close a client we created; a caller-supplied one is theirs.
        if self._owns_http_client and self._http_client is not None:
            await self._http_client.aclose()
            self._http_client = None

    async def __aenter__(self) -> "RealtimeClient":
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        await self.aclose()


class SessionHandle:
    """Return value of :meth:`RealtimeAgent.start`: an awaitable that is also an async
    context manager, either form yielding the started :class:`RealtimeSession`.
    Created by the SDK — there is no reason to construct one yourself. Connects
    MCP servers (if any) at open, merges their tools into the session config,
    and binds their teardown to the session."""

    def __init__(
        self,
        post_session_start: Callable[
            [SessionConfig], Awaitable[SessionResponse]
        ],
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
    ) -> None:
        self._post_session_start = post_session_start
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
            )
            return await session._start(self._post_session_start)
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
    inputs: Mapping[str, str] | None = None
    instructions: str | None = None
    model: str | None = None
    model_options: RealtimeModelOptions | None = None
    voice: str | VoiceConfig | None = None
    tools: tuple[AgentTool, ...] | None = None
    interruption_sensitivity: InterruptionSensitivity | None = None
    greeting: str | None = None
    audio: AudioConfig | None = None
    mcp: tuple[McpStdioServer, ...] | None = None
    skills: tuple[Skill, ...] | None = None
    hooks: tuple[Hook | ServerHook, ...] | None = None

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

        Raises :class:`VersionMismatchError` when the server refuses the
        protocol version and :class:`SessionStartError` for any other
        rejection.
        """
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
                model_options=self.model_options,
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
            client._post_session_start,
            client._post_dial,
            client.get_session_usage,
            build_config,
            base_tools,
            self.mcp,
            on_state_change,
            hooks=HookEngine(client_hooks) if client_hooks is not None else None,
        )


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
