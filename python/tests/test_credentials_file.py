"""The impure layer of zero-argument credential resolution: path selection,
file reading, and what ``RealtimeClient()`` does with the result. Chain
semantics themselves are pinned by the shared conformance vectors."""

from __future__ import annotations

from pathlib import Path

import pytest

from cosmo_ai import RealtimeClient
from cosmo_ai._internal.credentials_file import resolve_credential, resolve_path
from cosmo_ai.errors import (
    CredentialsExpiredError,
    CredentialsFileError,
    CredentialsMismatchError,
    CredentialsNotFoundError,
)

_VALID_FILE = """\
version = 1

[default]
slug = "acme"
api_key = "cosmo_file_key"
api_key_id = "key-1"
base_url = "https://app.askcosmo.ai"
expires_at = "2099-01-01T00:00:00Z"
"""


def _write(tmp_path: Path, content: str) -> Path:
    path = tmp_path / "credentials"
    path.write_text(content)
    return path


def test_file_env_var_overrides_default_path(tmp_path: Path) -> None:
    path = _write(tmp_path, _VALID_FILE)
    resolved = resolve_credential({"COSMO_CREDENTIALS_FILE": str(path)})
    assert resolved.api_key == "cosmo_file_key"
    assert resolved.base_url == "https://app.askcosmo.ai"
    assert resolved.source == "file"


def test_default_path_is_home_dot_cosmo() -> None:
    assert resolve_path({}) == Path.home() / ".cosmo" / "credentials"


def test_unreadable_file_is_a_file_error(tmp_path: Path) -> None:
    path = tmp_path / "credentials"
    path.mkdir()  # a directory: read_text raises IsADirectoryError (OSError)
    with pytest.raises(CredentialsFileError) as exc_info:
        resolve_credential({"COSMO_CREDENTIALS_FILE": str(path)})
    assert exc_info.value.code == "file_invalid"
    assert str(path) in str(exc_info.value)


def test_missing_file_error_names_every_option(tmp_path: Path) -> None:
    path = tmp_path / "credentials"
    with pytest.raises(CredentialsNotFoundError) as exc_info:
        resolve_credential({"COSMO_CREDENTIALS_FILE": str(path)})
    message = str(exc_info.value)
    assert "COSMO_API_KEY" in message
    assert "cosmo login" in message
    assert str(path) in message


def test_client_resolves_env_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COSMO_API_KEY", "cosmo_env_key")
    monkeypatch.delenv("COSMO_BASE_URL", raising=False)
    client = RealtimeClient()
    assert client._credential is not None
    assert client._credential.get_secret_value() == "cosmo_env_key"
    assert client._can_mint is True
    assert client._base_url == "https://platform.askcosmo.ai"


def test_client_adopts_file_base_url(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = _write(tmp_path, _VALID_FILE)
    monkeypatch.delenv("COSMO_API_KEY", raising=False)
    monkeypatch.delenv("COSMO_BASE_URL", raising=False)
    monkeypatch.setenv("COSMO_CREDENTIALS_FILE", str(path))
    client = RealtimeClient()
    assert client._credential is not None
    assert client._credential.get_secret_value() == "cosmo_file_key"
    assert client._base_url == "https://app.askcosmo.ai"
    assert client._can_mint is True


def test_client_conflicting_env_base_url_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = _write(tmp_path, _VALID_FILE)
    monkeypatch.delenv("COSMO_API_KEY", raising=False)
    monkeypatch.setenv("COSMO_BASE_URL", "http://localhost:8123")
    monkeypatch.setenv("COSMO_CREDENTIALS_FILE", str(path))
    with pytest.raises(CredentialsMismatchError) as exc_info:
        RealtimeClient()
    message = str(exc_info.value)
    assert "http://localhost:8123" in message
    assert "https://app.askcosmo.ai" in message


def test_client_matching_env_base_url_resolves(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = _write(tmp_path, _VALID_FILE)
    monkeypatch.delenv("COSMO_API_KEY", raising=False)
    monkeypatch.setenv("COSMO_BASE_URL", "https://app.askcosmo.ai/")
    monkeypatch.setenv("COSMO_CREDENTIALS_FILE", str(path))
    client = RealtimeClient()
    assert client._base_url == "https://app.askcosmo.ai"


def test_client_without_any_credential_raises_not_found(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("COSMO_API_KEY", raising=False)
    monkeypatch.setenv("COSMO_CREDENTIALS_FILE", str(tmp_path / "credentials"))
    with pytest.raises(CredentialsNotFoundError):
        RealtimeClient()


def test_client_with_expired_file_key_raises_expired(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = _write(
        tmp_path, _VALID_FILE.replace("2099-01-01T00:00:00Z", "2020-01-01T00:00:00Z")
    )
    monkeypatch.delenv("COSMO_API_KEY", raising=False)
    monkeypatch.setenv("COSMO_CREDENTIALS_FILE", str(path))
    with pytest.raises(CredentialsExpiredError) as exc_info:
        RealtimeClient()
    assert "cosmo login" in str(exc_info.value)


def test_client_explicit_credential_skips_resolution(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("COSMO_API_KEY", "cosmo_env_key")
    monkeypatch.delenv("COSMO_BASE_URL", raising=False)
    client = RealtimeClient(api_key="cosmo_explicit")
    assert client._credential is not None
    assert client._credential.get_secret_value() == "cosmo_explicit"


def test_client_both_credentials_still_rejected() -> None:
    with pytest.raises(ValueError):
        RealtimeClient(api_key="cosmo_x", token="jwt_y")


def test_client_explicit_token_cannot_mint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("COSMO_BASE_URL", raising=False)
    client = RealtimeClient(token="jwt_y")
    assert client._can_mint is False
