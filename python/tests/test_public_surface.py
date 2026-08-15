"""The public export surface: every name in ``__all__`` resolves, and the
tool-authoring layering (basics at the root, raw specs under ``cosmo_ai.tools``)
holds."""

from __future__ import annotations

import pytest

import cosmo_ai as cr
import cosmo_ai.tools as tools_mod
from cosmo_ai._internal.protocol import AgentTool, RealtimeToolSpec


def test_every_root_export_resolves() -> None:
    for name in cr.__all__:
        assert getattr(cr, name) is not None, name


def test_every_tools_export_resolves() -> None:
    for name in tools_mod.__all__:
        assert getattr(tools_mod, name) is not None, name


def test_agent_tool_is_exported_at_the_root() -> None:
    # It annotates the ``tools=`` parameter on ``RealtimeClient.agent`` /
    # ``catalog_agent`` and the ``RealtimeAgent`` dataclass, so a caller writing
    # ``list[AgentTool]`` has a supported import.
    assert "AgentTool" in cr.__all__
    assert cr.AgentTool is AgentTool


def test_raw_tool_specs_stay_under_the_tools_module_not_the_root() -> None:
    # The escape-hatch specs are "tool authoring beyond the basics"; the
    # everyday path is the ``@tool`` decorator, exported at the root.
    for name in (
        "ClientTool",
        "BackgroundClientTool",
        "ToolSchemaError",
        "ToolInputValidationError",
    ):
        assert name in tools_mod.__all__, name
        assert name not in cr.__all__, name


@pytest.mark.parametrize(
    ("old", "new"),
    [("CosmoRealtime", "RealtimeClient"), ("Agent", "RealtimeAgent")],
)
def test_renamed_entry_points_are_gone_not_aliased(old: str, new: str) -> None:
    # A silent alias would let the old spelling live on in user code and docs;
    # this rename is a clean break, so the old name must not resolve at all.
    assert not hasattr(cr, old)
    assert old not in cr.__all__
    assert new in cr.__all__


def test_wire_twin_union_is_not_public() -> None:
    # ``RealtimeToolSpec`` is the discriminated serialization twin of
    # ``AgentTool`` — internal machinery, not an authoring type.
    assert "RealtimeToolSpec" not in cr.__all__
    assert "RealtimeToolSpec" not in tools_mod.__all__
    assert RealtimeToolSpec is not None  # importable only via the private path
