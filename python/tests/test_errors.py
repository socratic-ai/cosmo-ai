"""The error-hierarchy contract: every public SDK error is catchable as
:class:`RealtimeError`, and the compat bases (``ValueError`` for config
errors, ``ImportError`` for missing extras) are preserved."""

from __future__ import annotations

import httpx
import pytest
from cosmo_ai import (
    AudioUnavailableError,
    RealtimeError,
    DialError,
    ExtraNotInstalledError,
    MintTokenError,
    NotConnectedError,
    SessionStartError,
    VersionMismatchError,
)
from cosmo_ai.client import _parse_error_detail
from cosmo_ai.mcp import McpConfigError, McpExtraNotInstalledError
from cosmo_ai.skills import SkillParseError
from cosmo_ai.tools import ToolSchemaError


@pytest.mark.parametrize(
    "err_cls",
    [
        AudioUnavailableError,
        DialError,
        ExtraNotInstalledError,
        McpConfigError,
        McpExtraNotInstalledError,
        MintTokenError,
        NotConnectedError,
        SessionStartError,
        SkillParseError,
        ToolSchemaError,
        VersionMismatchError,
    ],
)
def test_every_public_error_is_catchable_as_cosmo_ai_error(
    err_cls: type[Exception],
) -> None:
    assert issubclass(err_cls, RealtimeError)


def test_config_errors_keep_value_error_compat() -> None:
    assert issubclass(SkillParseError, ValueError)
    assert issubclass(McpConfigError, ValueError)


def test_missing_extra_errors_are_import_errors() -> None:
    assert issubclass(ExtraNotInstalledError, ImportError)
    assert issubclass(McpExtraNotInstalledError, ExtraNotInstalledError)


def test_request_validation_array_names_the_offending_fields() -> None:
    # The shape a client newer than its backend gets: pydantic's
    # ``extra="forbid"`` on a field that backend has no model for. Without a
    # branch for it the message is the raw payload, truncated.
    response = httpx.Response(
        422,
        json={
            "detail": [
                {
                    "type": "extra_forbidden",
                    "loc": ["body", "agent", "inline", "audio"],
                    "msg": "Extra inputs are not permitted",
                }
            ]
        },
    )
    code, message = _parse_error_detail(response)
    assert code == "invalid_session_config"
    assert message == "agent.inline.audio: Extra inputs are not permitted"


def test_request_validation_array_caps_rendered_entries() -> None:
    response = httpx.Response(
        422,
        json={
            "detail": [
                {"loc": ["body", "agent", f"f{i}"], "msg": "nope"} for i in range(7)
            ]
        },
    )
    _, message = _parse_error_detail(response)
    assert "agent.f4: nope" in message
    assert "agent.f5" not in message
    assert "(+2 more)" in message
