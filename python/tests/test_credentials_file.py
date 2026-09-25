"""The impure layer of zero-argument credential resolution: path selection,
file reading, and what ``RealtimeClient()`` does with the result. Chain
semantics themselves are pinned by the shared conformance vectors."""

from __future__ import annotations

from pathlib import Path

import pytest

from cosmo_ai import CredentialsError, CredentialsErrorCode, RealtimeClient
from cosmo_ai._internal.credentials_file import resolve_credential, resolve_path

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
    with pytest.raises(CredentialsError) as exc_info:
        resolve_credential({"COSMO_CREDENTIALS_FILE": str(path)})
    assert exc_info.value.code == "file_invalid"
    assert str(path) in str(exc_info.value)


def test_missing_file_error_names_every_option(tmp_path: Path) -> None:
    path = tmp_path / "credentials"
    with pytest.raises(CredentialsError) as exc_info:
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
    with pytest.raises(CredentialsError) as exc_info:
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
    with pytest.raises(CredentialsError):
        RealtimeClient()


def test_client_with_expired_file_key_raises_expired(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = _write(
        tmp_path, _VALID_FILE.replace("2099-01-01T00:00:00Z", "2020-01-01T00:00:00Z")
    )
    monkeypatch.delenv("COSMO_API_KEY", raising=False)
    monkeypatch.setenv("COSMO_CREDENTIALS_FILE", str(path))
    with pytest.raises(CredentialsError) as exc_info:
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


def test_an_api_key_in_the_token_slot_is_refused() -> None:
    """The incident path: a pasted key in ``token=`` would be honored as a
    bearer by the backend and shipped to end users. It fails at construction
    instead, naming the right parameter."""
    # CredentialsError is a ValueError, so asserting the base would pass
    # whether or not the guard is typed. Assert the code.
    with pytest.raises(CredentialsError, match="api_key") as caught:
        RealtimeClient(token="cosmo_" + "a" * 64)
    assert caught.value.code is CredentialsErrorCode.API_KEY_IN_TOKEN_SLOT


def test_a_bom_prefixed_api_key_in_the_token_slot_is_still_refused() -> None:
    """Trimming must not open the guard it sits next to. A key pasted with a
    byte-order mark still starts with ``cosmo_`` once it is cleaned, so it has
    to be refused as a key in the token slot rather than cleaned into a usable
    bearer credential."""
    with pytest.raises(CredentialsError, match="api_key") as caught:
        RealtimeClient(token="\ufeff" + "cosmo_" + "a" * 64)
    assert caught.value.code is CredentialsErrorCode.API_KEY_IN_TOKEN_SLOT

    with pytest.raises(CredentialsError) as spaced:
        RealtimeClient(token="  cosmo_" + "a" * 64 + "\n")
    assert spaced.value.code is CredentialsErrorCode.API_KEY_IN_TOKEN_SLOT


def test_both_credentials_at_once_is_refused() -> None:
    with pytest.raises(CredentialsError) as caught:
        RealtimeClient(api_key="cosmo_" + "a" * 64, token="cosmo_pat_" + "b" * 32)
    assert caught.value.code is CredentialsErrorCode.CONFLICTING_CREDENTIALS


def test_a_credential_with_surrounding_whitespace_or_bom_is_usable() -> None:
    """A key read from a file or an env var carries what wrote it: a trailing
    newline from a shell redirect, a byte-order mark from PowerShell's UTF-8.
    httpx raises from inside the request on either — UnicodeEncodeError for the
    BOM, "Illegal header value" for the newline — so they are trimmed here."""
    key = "cosmo_" + "a" * 64
    for raw in (key + "\n", "\ufeff" + key, "  " + key + " ", key + "\r\n"):
        client = RealtimeClient(api_key=raw)
        assert client._credential is not None
        assert client._credential.get_secret_value() == key


def test_a_credential_that_cannot_go_in_a_header_is_refused() -> None:
    """Trimming ends at the edges: a stray character inside the value is a
    wrong credential, and is named as one instead of failing later inside the
    HTTP client, outside the error family a caller catches."""
    with pytest.raises(CredentialsError) as caught:
        RealtimeClient(api_key="cosmo_aaa\nbbb")
    assert caught.value.code is CredentialsErrorCode.MALFORMED_CREDENTIAL

    with pytest.raises(CredentialsError) as empty:
        RealtimeClient(api_key="   ")
    assert empty.value.code is CredentialsErrorCode.MALFORMED_CREDENTIAL


def test_minted_jwts_and_acts_as_user_tokens_pass_the_token_slot() -> None:
    RealtimeClient(token="eyJhbGciOiJIUzI1NiJ9.payload.sig")
    RealtimeClient(token="cosmo_pat_" + "b" * 32)
