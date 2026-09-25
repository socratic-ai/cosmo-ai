"""Typed errors raised by the SDK."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field, fields
from enum import Enum
from typing import Any


class RealtimeError(Exception):
    """Base for every error this SDK raises."""

    message: str
    """Human-readable explanation, for logs and display. Written for a person
    and free to change between releases — branch on the ``code`` the raising
    error carries, never on this."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class AudioUnavailableErrorCode(str, Enum):
    """Which audio failure occurred.

    Closed: every one is raised by this SDK, so it changes only when the SDK
    does. Each SDK reports the ones its platform can tell apart — a member
    absent from one platform's vocabulary is still declared, so a ``match``
    written against it stays exhaustive everywhere.
    """

    MIC_DENIED = "mic_denied"
    """The host refused microphone permission. Nothing retries around it —
    the user grants access, or the session runs without a microphone."""
    MIC_NOT_FOUND = "mic_not_found"
    """No input device exists to open."""
    MIC_IN_USE = "mic_in_use"
    """An input device exists but another process holds it exclusively."""
    AUDIO_UNAVAILABLE = "audio_unavailable"
    """Audio could not be initialized and the platform did not say which of
    the above it was. Reported for playback failures too — on this SDK, a
    missing or unloadable PortAudio runtime."""


class AudioUnavailableError(RealtimeError):
    """OS audio could not be initialized.

    For capture, no input device could be opened — a headless host, a denied
    microphone permission, or a device another process holds exclusively. For
    playback, the PortAudio system library is missing or failed to load; the
    sounddevice wheel bundles it on macOS and Windows, so in practice that is a
    Linux host without the distribution's PortAudio runtime installed.

    ``code`` names which of those it was — branch on it rather than on the
    message. This SDK reports ``MIC_NOT_FOUND`` when the Audio Device Module
    lists no recording device, and ``AUDIO_UNAVAILABLE`` for everything else:
    a device that exists but will not open is either a refused permission or
    one another process holds, and neither PortAudio nor the ADM separates
    those."""

    def __init__(
        self,
        message: str,
        *,
        code: AudioUnavailableErrorCode = AudioUnavailableErrorCode.AUDIO_UNAVAILABLE,
    ) -> None:
        super().__init__(message)
        self.code = code


class SessionStateErrorCode(str, Enum):
    """Why the session could not serve the call.

    Closed: every one is raised by this SDK, so it changes only when the SDK
    does. Every member is declared in every SDK even where that SDK cannot
    reach the case, so a branch written against one ports unchanged.
    """

    NOT_CONNECTED = "not_connected"
    """The session is not live. Either it has not reached ``ready`` yet — wait
    for it — or it has already ended, in which case start a new one."""
    ALREADY_STARTED = "already_started"
    """The session was already started. A session is single-attempt; build a
    new one rather than restarting this one."""
    AUDIO_PUBLISH_ALREADY_ACTIVE = "audio_publish_already_active"
    """A second audio publish was requested while one was live. A session
    carries one voice — the microphone or a caller-owned stream, never both."""
    VIDEO_PUBLISH_ALREADY_ACTIVE = "video_publish_already_active"
    """A second video publish was requested while one was live, so a camera
    stream and a screen share cannot run together."""
    SCREEN_SHARE_UNAVAILABLE = "screen_share_unavailable"
    """Screen capture could not be started by the platform."""
    INVALID_PAYLOAD = "invalid_payload"
    """A caller-supplied payload would violate a wire-protocol invariant."""


class SessionStateError(RealtimeError):
    """The session cannot serve this call in its current state.

    Raised on a live-session method rather than at start: a send before
    ``ready`` or after the session ended, a second publish on a track that
    carries one, a restart of a single-attempt session. ``code`` names which —
    branch on it rather than on the message."""

    def __init__(self, *, code: SessionStateErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code


class ToolDefinitionErrorCode(str, Enum):
    """What is wrong with a tool declaration.

    Closed: every one is raised when a tool is constructed, so it changes
    only when the SDK does. Every member is declared in every SDK even where
    that SDK cannot reach the case, so a branch written against one ports
    unchanged.
    """

    ADDITIONAL_PROPERTIES_FORBIDDEN = "additional_properties_forbidden"
    """``additionalProperties`` is set to a value the dialect refuses."""
    FORBIDDEN_KEY = "forbidden_key"
    """The schema uses a keyword the dialect does not accept — ``$ref``, ``format``, ``oneOf``, ``pattern`` and friends."""
    FORBIDDEN_TYPE = "forbidden_type"
    """The schema declares a type outside the accepted set."""
    INVALID_ANY_OF = "invalid_any_of"
    """``anyOf`` is present but is not a list of schemas."""
    INVALID_BOUND = "invalid_bound"
    """A numeric bound (``minimum``, ``maxLength``, …) is not a number."""
    INVALID_DEFAULT = "invalid_default"
    """``default`` is present but is not a scalar."""
    INVALID_ENUM = "invalid_enum"
    """``enum`` is present but its members are not scalars."""
    INVALID_PROPERTIES = "invalid_properties"
    """``properties`` is present but is not a map of names to schemas."""
    INVALID_REQUIRED = "invalid_required"
    """``required`` is not a list of property names."""
    INVALID_TEXT = "invalid_text"
    """A description or other model-facing string carries a control character. Also raised for the tool's own description."""
    MAX_DEPTH_EXCEEDED = "max_depth_exceeded"
    """The schema nests deeper than the dialect allows."""
    MAX_PROPERTIES_EXCEEDED = "max_properties_exceeded"
    """The schema declares more properties than the dialect allows."""
    NODE_NOT_OBJECT = "node_not_object"
    """A nested schema node is not an object."""
    RECURSIVE_SCHEMA = "recursive_schema"
    """The schema refers to itself, through a ``$ref`` cycle the restricted
    dialect cannot express."""
    TOP_LEVEL_NOT_OBJECT = "top_level_not_object"
    """The top-level schema is not an object. A tool's input is always a set of named parameters."""
    INVALID_TOOL_NAME = "invalid_tool_name"
    """The tool's name does not match the required pattern."""
    MISSING_DESCRIPTION = "missing_description"
    """The tool has no description. It is model-facing and required."""
    DESCRIPTION_TOO_LONG = "description_too_long"
    """The tool's description is longer than the protocol allows."""
    SCHEMA_TYPE_MISMATCH = "schema_type_mismatch"
    """A schema and the type it decodes into disagree. Raised only by the Swift consistency-check helper; declared everywhere so a ``match`` ports unchanged."""


class ToolDefinitionError(RealtimeError, ValueError):
    """A tool declaration is invalid — a bad name, a missing or overlong
    description, or an input schema that cannot be expressed in the restricted
    dialect the realtime backend accepts.

    Raised when the tool is constructed, typically at import or startup, never
    at session connect. ``code`` names which — branch on it rather than on the
    message. Also a :class:`ValueError`, so the argument-validation handling a
    caller already has keeps working."""

    def __init__(self, *, code: ToolDefinitionErrorCode, message: str) -> None:
        super().__init__(f"{code.value}: {message}" if message else code.value)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class ToolInputIssue:
    """One field-level violation on a tool call's arguments. Built from
    structured fields only — the submitted value never appears here."""

    path: str
    """Dotted path to the offending field (``address.city``, ``items[2].sku``),
    or ``(root)`` when the whole argument object was rejected."""
    code: str
    """The validator's stable issue code (``missing``, ``string_type``, …)."""
    constraint: str
    """The violated constraint (``required``, ``expected a string``, …)."""


class ToolInputValidationError(RealtimeError):
    """The model's arguments failed validation inside a builder-synthesized
    tool handler. The message follows the normalized ``INVALID_INPUT`` shape
    and is built from structured issue fields only — submitted values never
    appear, in the message or in ``issues``."""

    def __init__(self, message: str, *, issues: list[ToolInputIssue]) -> None:
        self.issues = issues
        super().__init__(message)


class HookErrorCode(str, Enum):
    """Why a hook could not be registered.

    Closed: every one is raised when hooks are declared, so it changes only
    when the SDK does. Every member is declared in every SDK even where that
    SDK cannot reach the case, so a branch written against one ports
    unchanged.
    """

    MALFORMED_MATCHER = "malformed_matcher"
    """The matcher pattern does not parse — an unterminated ``[`` group. The
    underlying matcher never errors on one, it just silently matches nothing,
    which for a deny matcher is a guard that never fires."""
    INVALID_HOOK = "invalid_hook"
    """A ``hooks`` element is neither a hook built by a seam decorator nor a
    server hook. Not raised by SDKs whose type system rejects it first."""
    SERVER_HOOK_NOT_ALLOWED = "server_hook_not_allowed"
    """A server hook was passed to a catalog agent, which runs its stored
    configuration verbatim."""


class HookError(RealtimeError, ValueError):
    """A hook could not be registered.

    ``MALFORMED_MATCHER`` and ``INVALID_HOOK`` are raised where the hook is
    declared — a matcher that would never fire is refused up front rather than
    silently matching nothing. ``SERVER_HOOK_NOT_ALLOWED`` is raised where the
    agent is built, which in this SDK is :meth:`RealtimeClient.catalog_agent`.
    ``code`` names which — branch on it rather than on the message. Also a
    :class:`ValueError`, so the argument-validation handling a caller already
    has keeps working."""

    def __init__(self, *, code: HookErrorCode, message: str) -> None:
        super().__init__(f"{code.value}: {message}" if message else code.value)
        self.code = code
        self.message = message


class CredentialsErrorCode(str, Enum):
    """Why the client has no usable credential.

    Closed: every one is raised by this SDK. The first five are the slugs the
    cross-SDK resolution vectors pin
    (``contract/credentials-resolution-vectors.json``); the rest cover a
    credential supplied in a way the SDK refuses to send.
    """

    NO_CREDENTIAL = "no_credential"
    """Nothing to authenticate with: nothing passed, ``COSMO_API_KEY`` unset,
    and no credentials file. The message names every way to supply one."""
    PROFILE_NOT_FOUND = "profile_not_found"
    """The requested profile is not in the credentials file."""
    FILE_INVALID = "file_invalid"
    """The credentials file exists but cannot be used: not TOML, an unreadable
    version, or a profile missing required fields."""
    EXPIRED = "expired"
    """The stored API key's ``expires_at`` has passed; ``cosmo login`` mints a
    fresh one."""
    BASE_URL_MISMATCH = "base_url_mismatch"
    """``COSMO_BASE_URL`` names a different backend than the one the stored key
    was issued by. The key would only earn a 401 there, so the conflict is
    refused up front."""
    CONFLICTING_CREDENTIALS = "conflicting_credentials"
    """Both an API key and a token were supplied. Pass one."""
    MALFORMED_CREDENTIAL = "malformed_credential"
    """The credential carries characters an Authorization header cannot hold.
    Surrounding whitespace and a byte-order mark are trimmed first, so this is
    a credential that is wrong in its body, not one pasted with a stray
    newline."""
    API_KEY_IN_TOKEN_SLOT = "api_key_in_token_slot"
    """A workspace API key was passed as an end-user token. The backend would
    honor it as a bearer, which is how a key ends up shipped to end users, so
    it is refused here."""
    INSECURE_BASE_URL = "insecure_base_url"
    """The base URL is plain ``http`` to a non-loopback host. A bearer
    credential must not travel over cleartext."""


class CredentialsError(RealtimeError, ValueError):
    """The client has no usable credential.

    Covers resolving one from the environment or the ``cosmo login``
    credentials file, and refusing one supplied in a way that would leak it or
    fail on arrival. Always before a request carries the credential, but not
    always at the same call: the resolution codes come from a zero-argument
    :class:`RealtimeClient`, while ``INSECURE_BASE_URL`` is raised wherever the
    base URL is about to be used — client construction and
    :meth:`TokenSource.endpoint`. ``code`` names which — branch on it rather than on the message.
    Also a :class:`ValueError`, so the argument-validation handling a caller
    already has keeps working."""

    def __init__(self, *, code: CredentialsErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code


class SessionStartErrorCode(str, Enum):
    """Why ``start`` did not produce a live session.

    Closed: every one is raised by this SDK, so it changes only when the SDK
    does. It says what happened to the attempt, never the server's own slug
    for why it refused — that is an open set, on ``server_code``.
    """

    TRANSPORT = "transport"
    """The request never reached the server, so nothing happened server-side
    and retrying is safe."""
    INVALID_RESPONSE = "invalid_response"
    """The server answered, but not with a body this SDK could parse. The
    session may already exist, so this is not safe to retry blindly."""
    CONFIG = "config"
    """The server refused the session configuration — an unavailable model, a
    tool config it cannot accept, instructions past its limit."""
    BUSY = "busy"
    """The workspace is at its concurrent-session limit. Usually an abandoned
    session still holding a slot; retrying shortly after succeeds, and
    ``retry_after_seconds`` carries the server's ``Retry-After`` when it sent
    one."""
    ENTITLEMENT = "entitlement"
    """The plan refused the session: the free voice grant is spent, or the
    model's provider is not included. Not retryable — the workspace needs a
    payment method or a plan change."""
    VERSION_MISMATCH = "version_mismatch"
    """This SDK is older than the server's supported floor. Upgrade the
    package; nothing about the session can be retried."""
    VOICE_DISABLED = "voice_disabled"
    """Realtime voice is not configured for this deployment or workspace."""
    REJECTED = "rejected"
    """The server refused for a reason with no more specific code.
    ``server_code`` carries its own slug."""
    JOIN_FAILED = "join_failed"
    """The transport could not join the room. The server accepted the session,
    so this is not a rejection and carries no verdict from it — the join
    itself is what failed."""
    HANDSHAKE_FAILED = "handshake_failed"
    """The transport joined but the room closed before ``ready`` — a failed
    boot. The session is torn down before ``start`` raises."""
    READY_TIMEOUT = "ready_timeout"
    """The transport joined but the server's ready handshake never arrived
    within the wait budget. The session is torn down before ``start``
    raises."""


@dataclass(frozen=True, slots=True)
class SessionStartRejection:
    """The server's structured reason for refusing a session start.

    Every field beyond ``code`` and ``message`` belongs to one rejection, and
    ``code`` says which — read the group that matches and ignore the rest.
    ``extra`` carries anything the server sent that this SDK does not name, so
    a field added server-side is passed through rather than dropped.
    """

    code: str | None = None
    """The server's stable rejection slug — the same value as
    ``SessionStartError.server_code``. Match on this to know which group of
    fields below is populated."""
    message: str | None = None
    """Human-readable reason, written for a person to read."""

    limit: int | None = None
    """``concurrent_session_limit``: the workspace's cap on live sessions."""
    active: int | None = None
    """``concurrent_session_limit``: sessions already running against that
    cap."""

    granted_minutes: int | None = None
    """``free_minutes_exhausted``: minutes the free grant allowed in total."""
    used_minutes: int | None = None
    """``free_minutes_exhausted``: minutes already spent against that grant."""

    balance_cents: int | None = None
    """``insufficient_credits``: prepaid balance remaining, in cents."""
    top_up_path: str | None = None
    """``insufficient_credits``: where to add credit."""

    meter: str | None = None
    """``quota_exceeded``: which allowance was exceeded."""
    included: int | None = None
    """``quota_exceeded``: how much the plan includes."""
    used: int | None = None
    """``quota_exceeded``: how much has been used."""
    reset_at: str | None = None
    """``quota_exceeded``: when the allowance renews, or ``None`` when it will
    not — a fixed term has ended and the way back is a plan change."""

    provider: str | None = None
    """``provider_not_entitled``: the model provider the plan excludes."""
    allowed_providers: list[str] | None = None
    """``provider_not_entitled``: the providers it does include."""
    plan: str | None = None
    """``provider_not_entitled`` / ``workspace_limit_reached``: the plan in
    force."""
    upgrade_path: str | None = None
    """``provider_not_entitled`` / ``workspace_limit_reached``: where to
    upgrade."""

    extra: Mapping[str, Any] = field(default_factory=dict)
    """Fields the server sent that this SDK does not name."""

    @classmethod
    def _from_body(cls, body: Mapping[str, Any]) -> "SessionStartRejection":
        """Build one from a rejection body, keeping unnamed fields on
        ``extra``."""
        named = {f.name for f in fields(cls)} - {"extra"}
        return cls(
            **{k: v for k, v in body.items() if k in named},
            extra={k: v for k, v in body.items() if k not in named},
        )


class SessionStartError(RealtimeError):
    """``start`` did not produce a live session.

    Covers the whole start sequence, which is more than one request: the
    session-start call, the transport join, and the server's ready handshake.
    ``code`` names how far it got — branch on it rather than on the message.

    ``server_code`` is the server's own rejection slug when it sent one, an
    open set. ``status`` is the HTTP status of a server rejection, ``None``
    when the request never reached the server or its response could not be
    read. ``retry_after_seconds`` is set only for ``BUSY``, and only when the
    server sent a ``Retry-After``. ``detail`` is the server's structured
    reason when the rejection carried one."""

    def __init__(
        self,
        *,
        code: SessionStartErrorCode,
        message: str,
        status: int | None = None,
        server_code: str | None = None,
        retry_after_seconds: int | None = None,
        detail: SessionStartRejection | None = None,
    ) -> None:
        super().__init__(f"{code.value}: {message}" if message else code.value)
        self.code = code
        self.message = message
        self.status = status
        self.server_code = server_code
        self.retry_after_seconds = retry_after_seconds
        self.detail = detail


_START_REJECTION_CODES = {
    "concurrent_session_limit": SessionStartErrorCode.BUSY,
    "free_minutes_exhausted": SessionStartErrorCode.ENTITLEMENT,
    "provider_not_entitled": SessionStartErrorCode.ENTITLEMENT,
    "version_mismatch": SessionStartErrorCode.VERSION_MISMATCH,
}


def _classify_start_rejection(
    server_code: str | None, status: int | None
) -> SessionStartErrorCode:
    """Map one session-start rejection onto its closed code.

    The slug decides when the meaning cannot be read off the status —
    ``contract/session-start-error-vectors.json`` pins those pairs and every
    SDK classifies them the same way. Everything else is read from the status,
    which already says whether the body was refused.
    """
    if server_code is not None and server_code in _START_REJECTION_CODES:
        return _START_REJECTION_CODES[server_code]
    if status == 503:
        return SessionStartErrorCode.VOICE_DISABLED
    if status in (400, 422):
        return SessionStartErrorCode.CONFIG
    return SessionStartErrorCode.REJECTED


class ApiError(RealtimeError):
    """A request to the Cosmo backend failed.

    The base every per-call error descends from — :class:`MintTokenError`,
    :class:`TokenSourceError`, :class:`VerifyError`, :class:`UsageError`,
    :class:`DialError` — so one ``except ApiError`` covers any backend call
    while catching a specific one still tells you which call it was. Starting
    a session raises :class:`SessionStartError` instead, which carries the HTTP
    status a start rejection turns on.

    Each subclass carries its own closed ``code``; ``server_code`` is the open
    half and lives here, because a rejection slug belongs to whichever backend
    answered rather than to the call that asked."""

    def __init__(self, message: str, *, server_code: str | None = None) -> None:
        super().__init__(message)
        self.server_code = server_code


class VerifyErrorCode(str, Enum):
    """How far a credential check got before it failed.

    Closed: every one is raised by this SDK, so it changes only when the
    SDK does. It says what happened to the attempt, never why the server
    refused — that is the server's own slug, an open set, on
    ``ApiError.server_code``.
    """

    REQUEST_FAILED = "request_failed"
    """The request did not produce a usable answer — a network failure or
    timeout, or a redirect, which is refused rather than followed so a
    credential is never re-sent to another origin."""
    REQUEST_REJECTED = "request_rejected"
    """The server refused. ``server_code`` carries its own slug for why."""
    INVALID_RESPONSE = "invalid_response"
    """The server answered, but not with a body this SDK could parse."""


class UsageErrorCode(str, Enum):
    """How far a usage read got before it failed.

    Closed: every one is raised by this SDK, so it changes only when the
    SDK does. It says what happened to the attempt, never why the server
    refused — that is the server's own slug, an open set, on
    ``ApiError.server_code``.
    """

    REQUEST_FAILED = "request_failed"
    """The request did not produce a usable answer — a network failure or
    timeout, or a redirect, which is refused rather than followed so a
    credential is never re-sent to another origin."""
    REQUEST_REJECTED = "request_rejected"
    """The server refused. ``server_code`` carries its own slug for why."""
    INVALID_RESPONSE = "invalid_response"
    """The server answered, but not with a body this SDK could parse."""
    INVALID_REQUEST = "invalid_request"
    """The SDK refused to make the call — this session carries no usage
    surface. Nothing reached the server."""


class DialErrorCode(str, Enum):
    """How far a dial got before it failed.

    Closed: every one is raised by this SDK, so it changes only when the
    SDK does. It says what happened to the attempt, never why the server
    refused — that is the server's own slug, an open set, on
    ``ApiError.server_code``.
    """

    REQUEST_FAILED = "request_failed"
    """The request did not produce a usable answer — a network failure or
    timeout, or a redirect, which is refused rather than followed so a
    credential is never re-sent to another origin."""
    REQUEST_REJECTED = "request_rejected"
    """The server refused. ``server_code`` carries its own slug for why."""
    INVALID_RESPONSE = "invalid_response"
    """The server answered, but not with a body this SDK could parse."""
    INVALID_REQUEST = "invalid_request"
    """The SDK refused to send the request — a malformed phone number, or a
    session that cannot be dialed. Nothing reached the server."""


class MintTokenErrorCode(str, Enum):
    """How far a token request got before it failed.

    Raised by :meth:`RealtimeClient.mint_token`. Resolving a
    :class:`TokenSource` raises :class:`TokenSourceError` instead.

    Closed: every one is raised by this SDK, so it changes only when the SDK
    does. It says what happened to the attempt, never why the server refused —
    that is the server's own slug, an open set, on ``server_code``.
    """

    REQUEST_FAILED = "request_failed"
    """The request did not produce a usable answer — a transport failure or
    timeout, or a redirect, which is refused rather than followed so a
    workspace key is never re-sent to another origin. A redirect will not
    resolve on retry; a transport failure may."""
    INVALID_RESPONSE = "invalid_response"
    """The server answered, but not with a token this SDK could parse."""
    REQUEST_REJECTED = "request_rejected"
    """The server refused. ``server_code`` carries its own slug for why."""
    MISSING_API_KEY = "missing_api_key"
    """Minting needs a workspace API key, and this client was built with an
    end-user token. Tokens cannot mint tokens."""


class MintTokenError(ApiError):
    """``mint_token`` failed.

    ``code`` names what this SDK saw — match on it rather than on the message,
    which is written for a human. When it is ``REQUEST_REJECTED`` the server declined
    the request and ``server_code`` carries the server's own slug, an open set:
    a typed rejection such as ``"workspace_forbidden"``, or a synthetic
    ``"http_<status>"`` when the response carried none."""

    def __init__(
        self,
        *,
        code: MintTokenErrorCode,
        message: str,
        server_code: str | None = None,
    ) -> None:
        super().__init__(message, server_code=server_code)
        self.code = code

class TokenSourceErrorCode(str, Enum):
    """Why a :class:`TokenSource` could not produce a token.

    Closed: every one is raised by this SDK. The token endpoint's own
    rejection slug is open and rides on ``server_code``.
    """

    REQUEST_FAILED = "request_failed"
    """The token endpoint did not produce a usable answer — it could not be
    reached, or it answered with a redirect, which is refused rather than
    followed."""
    REQUEST_REJECTED = "request_rejected"
    """The token endpoint refused; ``server_code`` carries its slug."""
    INVALID_RESPONSE = "invalid_response"
    """The endpoint answered without a usable token."""
    FETCHER_FAILED = "fetcher_failed"
    """A custom :meth:`TokenSource.custom` callable raised."""


class TokenSourceError(ApiError):
    """A :class:`TokenSource` could not produce a token.

    Raised while the SDK obtains a credential for itself, which happens
    beneath every authenticated call — ``verify``, ``mint_token``, session
    start, dial and usage reads all resolve the source first, and it
    re-resolves on expiry and after a 401. So this surfaces from whichever
    call needed a token, not from one operation.

    ``code`` names what this SDK saw; ``server_code`` carries the token
    endpoint's own slug when ``code`` is ``REQUEST_REJECTED``."""

    def __init__(
        self,
        *,
        code: TokenSourceErrorCode,
        message: str,
        server_code: str | None = None,
    ) -> None:
        super().__init__(message, server_code=server_code)
        self.code = code


class VerifyError(ApiError):
    """``verify`` failed.

    ``code`` names how far the attempt got — a closed
    :class:`VerifyErrorCode`; the server's own rejection slug rides on
    ``server_code``. An invalid credential surfaces here; a valid one that
    simply cannot start sessions does not — that is a field on the returned
    :class:`CredentialInfo`."""

    def __init__(
        self, *, code: VerifyErrorCode, message: str, server_code: str | None = None
    ) -> None:
        super().__init__(
            f"{code.value}: {message}" if message else code.value,
            server_code=server_code,
        )
        self.code = code
        self.message = message


class UsageError(ApiError):
    """:meth:`RealtimeSession.usage` failed.

    ``code`` names how far the attempt got — a closed
    :class:`UsageErrorCode`; the server's own rejection slug rides on
    ``server_code``."""

    def __init__(
        self, *, code: UsageErrorCode, message: str, server_code: str | None = None
    ) -> None:
        super().__init__(
            f"{code.value}: {message}" if message else code.value,
            server_code=server_code,
        )
        self.code = code
        self.message = message


class DialError(ApiError):
    """:meth:`RealtimeSession.dial` failed.

    ``code`` names how far the attempt got — a closed
    :class:`DialErrorCode`. The server's own slug for a rejection
    (``"phone_calls_disabled"``, ``"minute_limit_exceeded"``,
    ``"session_not_found"``, ``"session_not_live"``,
    ``"session_already_dialed"``, …) is an open set and rides on
    ``server_code``."""

    def __init__(
        self, *, code: DialErrorCode, message: str, server_code: str | None = None
    ) -> None:
        super().__init__(
            f"{code.value}: {message}" if message else code.value,
            server_code=server_code,
        )
        self.code = code
        self.message = message
