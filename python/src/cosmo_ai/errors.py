"""Typed errors raised by the SDK."""

from __future__ import annotations

from typing import Any


class RealtimeError(Exception):
    """Base for every error this SDK raises."""


class ExtraNotInstalledError(RealtimeError, ImportError):
    """An optional dependency extra required by the requested feature is not
    installed. The message names the missing extra and the install command."""


class AudioUnavailableError(RealtimeError):
    """OS audio could not be initialized.

    For capture, no input device could be opened — a headless host, a denied
    microphone permission, or a device another process holds exclusively. For
    playback, the PortAudio system library is missing or failed to load; the
    sounddevice wheel bundles it on macOS and Windows, so in practice that is a
    Linux host without the distribution's PortAudio runtime installed."""


class AudioPublishAlreadyActiveError(RealtimeError):
    """A second audio publish was requested while one was live. A session
    carries one voice — the microphone or a caller-owned stream, never both —
    so the active one is stopped first."""


class ToolSchemaError(RealtimeError):
    """A tool's JSON Schema cannot be expressed in the restricted dialect the
    realtime backend accepts. Raised when the tool is constructed (typically
    import/startup), not at session connect. ``code`` is a stable slug shared
    with the cross-SDK conformance vectors (e.g. ``"forbidden_key"``,
    ``"max_depth_exceeded"``)."""

    def __init__(self, *, code: str, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(f"{code}: {message}" if message else code)


class ToolInputValidationError(RealtimeError):
    """The model's arguments failed validation inside a builder-synthesized
    tool handler. The message follows the normalized ``INVALID_INPUT`` shape
    and is built from structured issue fields only — submitted values never
    appear. ``issues`` carries the same sanitized issues structurally
    (``loc`` / ``type`` plus bound/expected context, values redacted)."""

    def __init__(self, message: str, *, issues: list[dict[str, Any]]) -> None:
        self.issues = issues
        super().__init__(message)


class CredentialsError(RealtimeError):
    """A zero-argument client could not resolve a credential from the
    environment or the ``cosmo login`` credentials file. ``code`` is a stable
    slug shared with the cross-SDK conformance vectors (``no_credential``,
    ``profile_not_found``, ``file_invalid``, ``expired``)."""

    def __init__(self, *, code: str, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(message)


class CredentialsNotFoundError(CredentialsError):
    """No credential anywhere: nothing passed, ``COSMO_API_KEY`` unset, and
    the credentials file (or the requested profile in it) absent. The message
    names every way to supply one."""


class CredentialsFileError(CredentialsError):
    """The credentials file exists but cannot be used: not TOML, an
    unreadable version, or a profile missing required fields."""


class CredentialsExpiredError(CredentialsError):
    """The stored API key's ``expires_at`` has passed; ``cosmo login``
    mints a fresh one."""


class CredentialsMismatchError(CredentialsError):
    """``COSMO_BASE_URL`` names a different backend than the one the stored
    key was issued by. The key would only earn a 401 there, so the conflict
    is refused up front; the message names both origins and the ways out."""


class SessionStartError(RealtimeError):
    """``connect`` failed before the session became usable.

    ``code`` is the server's stable error slug (e.g. ``"model_unavailable"``,
    ``"unavailable"``) when the rejection carried one, or a transport-level
    synthetic such as ``"http_503"`` / ``"room_join_failed"``.
    """

    def __init__(self, *, code: str, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(f"{code}: {message}" if message else code)


class VersionMismatchError(SessionStartError):
    """The server refused the session because this SDK speaks an incompatible
    external protocol version. Upgrade the SDK."""


class NotConnectedError(RealtimeError):
    """A send was attempted on a session that is not connected."""


class VideoPublishAlreadyActiveError(RealtimeError):
    """A second video publish was requested while one was live. A session
    publishes one video track at a time, so a camera stream and a screen share
    cannot run together — stop the active one first."""


class MintTokenError(RealtimeError):
    """``mint_token`` failed. ``code`` is the server's error slug when the
    rejection carried one, or a transport-level synthetic such as
    ``"transport_error"`` / ``"no_api_key"``."""

    def __init__(self, *, code: str, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(f"{code}: {message}" if message else code)


class VerifyError(RealtimeError):
    """``verify`` failed. ``code`` is the server's error slug when the
    rejection carried one, or a transport-level synthetic such as
    ``"transport_error"`` / ``"invalid_response"``. An invalid credential
    surfaces here; a valid one that simply cannot start sessions does not —
    that is a field on the returned :class:`CredentialInfo`."""

    def __init__(self, *, code: str, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(f"{code}: {message}" if message else code)


class UsageError(RealtimeError):
    """:meth:`RealtimeSession.usage` failed. ``code`` is the server's error
    slug when the rejection carried one, or a client-side synthetic
    (``"transport_error"`` / ``"invalid_response"`` / ``"unavailable"``)."""

    def __init__(self, *, code: str, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(f"{code}: {message}" if message else code)


class DialError(RealtimeError):
    """:meth:`RealtimeSession.dial` failed. ``code`` is the server's error
    slug when the rejection carried one (``"phone_calls_disabled"``,
    ``"minute_limit_exceeded"``, ``"session_not_found"``,
    ``"session_not_live"``, ``"session_already_dialed"``) or a client-side synthetic
    (``"invalid_phone_number"`` / ``"not_dialable"`` / ``"transport_error"``
    / ``"invalid_response"``). Auth / validation rejections without a slug
    surface the error type instead (e.g. ``"api_error"``)."""

    def __init__(self, *, code: str, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(f"{code}: {message}" if message else code)
