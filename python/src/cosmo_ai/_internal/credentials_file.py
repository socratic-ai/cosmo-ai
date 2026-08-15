"""Zero-argument credential resolution.

A client constructed with no explicit credential resolves one from, in order:

1. ``COSMO_API_KEY`` in the environment.
2. The ``cosmo login`` credentials file — ``COSMO_CREDENTIALS_FILE`` or
   ``~/.cosmo/credentials`` — at the profile named by ``COSMO_PROFILE``
   (else ``default``). The profile's ``base_url`` travels with the key: a
   stored credential is only valid against the backend it was issued for,
   so the file's origin wins over the SDK default, and a ``COSMO_BASE_URL``
   naming a *different* backend is refused rather than obeyed.

The file schema is owned by the cosmo CLI;
this reader mirrors its validation: version-gated, required non-empty string
fields, no silent fallback from a named profile to ``default``. Unlike the
CLI it also enforces ``expires_at``, because an SDK holding an expired key
would otherwise surface a bare 401 with no remediation.

Resolution semantics are pinned by the cross-SDK conformance vectors at
``credentials-resolution-vectors.json``.
"""

from __future__ import annotations

import os
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit
from typing import Any, Literal

if sys.version_info >= (3, 11):
    import tomllib
else:  # pragma: no cover - exercised on 3.10 CI
    import tomli as tomllib  # type: ignore[no-redef]

from cosmo_ai.errors import (
    CredentialsExpiredError,
    CredentialsFileError,
    CredentialsMismatchError,
    CredentialsNotFoundError,
)

CREDENTIALS_VERSION = 1
DEFAULT_PROFILE = "default"

API_KEY_ENV_VAR = "COSMO_API_KEY"
PROFILE_ENV_VAR = "COSMO_PROFILE"
FILE_ENV_VAR = "COSMO_CREDENTIALS_FILE"
_BASE_URL_ENV_VAR = "COSMO_BASE_URL"

_VERSION_KEY = "version"
_FIELDS = ("slug", "api_key", "api_key_id", "base_url", "expires_at")


@dataclass(frozen=True)
class ResolvedCredential:
    """The credential a zero-argument client runs with."""

    api_key: str
    # The origin to reach the backend at, or ``None`` for the SDK's normal
    # default. A profile's stored ``base_url`` for a file credential (a
    # conflicting ``COSMO_BASE_URL`` raises instead of overriding);
    # ``COSMO_BASE_URL`` itself for an environment credential.
    base_url: str | None
    source: Literal["env", "file"]


def resolve_path(environ: Mapping[str, str]) -> Path:
    override = environ.get(FILE_ENV_VAR)
    if override:
        return Path(override)
    return Path.home() / ".cosmo" / "credentials"


def resolve_credential(environ: Mapping[str, str] | None = None) -> ResolvedCredential:
    """Run the chain against the process environment and filesystem."""
    env = os.environ if environ is None else environ
    path = resolve_path(env)
    file_text = _read_text(path)
    return _resolve(env, file_text, str(path), now=datetime.now(timezone.utc))


def _resolve(
    environ: Mapping[str, str],
    file_text: str | None,
    path_display: str,
    *,
    now: datetime,
) -> ResolvedCredential:
    """The pure chain: environment map + file text in, credential out.

    Split from :func:`resolve_credential` so the conformance vectors can
    drive it without touching the process environment or filesystem.
    """
    env_base = (environ.get(_BASE_URL_ENV_VAR) or "").strip() or None

    env_key = (environ.get(API_KEY_ENV_VAR) or "").strip()
    if env_key:
        return ResolvedCredential(api_key=env_key, base_url=env_base, source="env")

    profile = environ.get(PROFILE_ENV_VAR) or DEFAULT_PROFILE
    if file_text is None:
        raise CredentialsNotFoundError(
            code="no_credential",
            message=(
                "No Cosmo credential found. Pass api_key= or token=, set "
                f"{API_KEY_ENV_VAR}, or sign in with: cosmo login\n"
                f"  (credentials file checked: {path_display})"
            ),
        )

    entry = _load_profile(file_text, profile, path_display)
    _reject_expired(entry["expires_at"], profile, path_display, now=now)
    _reject_base_url_conflict(env_base, entry["base_url"], profile, path_display)
    return ResolvedCredential(
        api_key=entry["api_key"],
        base_url=entry["base_url"],
        source="file",
    )


def _reject_base_url_conflict(
    env_base: str | None, stored_base: str, profile: str, path_display: str
) -> None:
    """A stored key is only valid where it was minted; a differing
    ``COSMO_BASE_URL`` would send it to a backend that never issued it and
    fail as an unexplained 401. Refuse with the remediation instead."""
    if env_base is None or _origin_key(env_base) == _origin_key(stored_base):
        return
    raise CredentialsMismatchError(
        code="base_url_mismatch",
        message=(
            f"COSMO_BASE_URL is {env_base}, but the stored key for profile "
            f"'{profile}' was issued by {stored_base} ({path_display}).\n"
            f"  Unset COSMO_BASE_URL, sign in against {env_base} with: "
            f"cosmo login\n"
            f"  (or pass a key for that backend explicitly / via COSMO_API_KEY)"
        ),
    )


def _origin_key(value: str) -> tuple[str, str, int | None] | str:
    """The effective origin: scheme, host, and port with scheme defaults
    applied, so ``https://x`` and ``https://x:443/`` compare equal. An
    unparseable value falls back to plain string comparison (fail closed)."""
    parsed = urlsplit(value.rstrip("/"))
    if not parsed.scheme or parsed.hostname is None:
        return value.rstrip("/").lower()
    scheme = parsed.scheme.lower()
    try:
        port = parsed.port
    except ValueError:
        return value.rstrip("/").lower()
    if port is None:
        port = {"https": 443, "http": 80}.get(scheme)
    return (scheme, parsed.hostname.lower(), port)


def _load_profile(
    file_text: str, profile: str, path_display: str
) -> dict[str, str]:
    try:
        document = tomllib.loads(file_text)
    except tomllib.TOMLDecodeError as exc:
        raise CredentialsFileError(
            code="file_invalid",
            message=(
                f"{path_display} is not valid TOML: {exc}\n"
                f"  Move it aside or delete it, then run: cosmo login"
            ),
        ) from exc

    _reject_unreadable_version(document, path_display)

    raw_entry: Any = document.get(profile)
    if not isinstance(raw_entry, dict):
        present = sorted(k for k, v in document.items() if isinstance(v, dict))
        raise CredentialsNotFoundError(
            code="profile_not_found",
            message=(
                f"No '{profile}' credentials in {path_display}.\n"
                f"  Profiles present: {', '.join(present) or '(none)'}\n"
                f"  Run: cosmo login"
            ),
        )

    values: dict[str, str] = {}
    missing: list[str] = []
    for name in _FIELDS:
        value = raw_entry.get(name)
        if isinstance(value, str) and value:
            values[name] = value
        else:
            missing.append(name)
    if missing:
        raise CredentialsFileError(
            code="file_invalid",
            message=(
                f"Profile '{profile}' in {path_display} is missing: "
                f"{', '.join(missing)}.\n  Run: cosmo login"
            ),
        )
    return values


def _reject_unreadable_version(document: dict[str, Any], path_display: str) -> None:
    version = document.get(_VERSION_KEY)
    if version is None:
        raise CredentialsFileError(
            code="file_invalid",
            message=(
                f"{path_display} predates the versioned credentials format.\n"
                f"  Run: cosmo login   (rewrites it, keeping a .bak copy)"
            ),
        )
    # `isinstance(True, int)` is True in Python, so state the whole shape
    # rather than only the ceiling — mirrors the CLI reader.
    if isinstance(version, bool) or not isinstance(version, int) or version < 1:
        raise CredentialsFileError(
            code="file_invalid",
            message=(
                f"{path_display}: '{_VERSION_KEY}' must be a positive integer, "
                f"found {version!r}.\n"
                f"  Move it aside or delete it, then run: cosmo login"
            ),
        )
    if version > CREDENTIALS_VERSION:
        raise CredentialsFileError(
            code="file_invalid",
            message=(
                f"{path_display} was written by a newer Cosmo CLI (format "
                f"{version}; this SDK understands {CREDENTIALS_VERSION}).\n"
                f"  Upgrade: pip install --upgrade cosmo-ai-sdk"
            ),
        )


def _reject_expired(
    expires_at: str, profile: str, path_display: str, *, now: datetime
) -> None:
    expiry = _parse_rfc3339(expires_at)
    if expiry is None:
        raise CredentialsFileError(
            code="file_invalid",
            message=(
                f"Profile '{profile}' in {path_display} has an unreadable "
                f"expires_at: {expires_at!r}.\n  Run: cosmo login"
            ),
        )
    if now >= expiry:
        raise CredentialsExpiredError(
            code="expired",
            message=(
                f"The stored API key for profile '{profile}' expired at "
                f"{expires_at} ({path_display}).\n  Run: cosmo login"
            ),
        )


def _parse_rfc3339(value: str) -> datetime | None:
    # 3.10's fromisoformat rejects a trailing 'Z'; normalize it first.
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed


def _read_text(path: Path) -> str | None:
    """The file's contents, or ``None`` when there is no file yet."""
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise CredentialsFileError(
            code="file_invalid",
            message=(
                f"Cannot read {path}: {exc.strerror or exc}.\n"
                f"  Fix its permissions, or point {FILE_ENV_VAR} elsewhere."
            ),
        ) from exc
