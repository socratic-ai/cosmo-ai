"""Skills wired through the RealtimeAgent API: the cosmo_sdk_load_skill tool and
resident menu appear in the assembled session-config."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from cosmo_ai.skills import Skill
from cosmo_ai.tools import ClientTool

from .fakes import start_body


def _skills() -> list[Skill]:
    return [
        Skill(name="activate-card", description="Activate the card.", body="b1"),
        Skill(name="faq", description="Answer FAQs.", body="b2"),
    ]


def test_skills_add_load_skill_tool_and_menu_to_config() -> None:
    body = start_body(instructions="You are Alex.", skills=_skills())

    tool_names = [t["name"] for t in body["agent"]["tools"]]
    assert "cosmo_sdk_load_skill" in tool_names

    instructions = body["agent"]["instructions"]
    assert instructions.startswith("You are Alex.")
    assert "You are Alex.\n\n## Skills" in instructions
    assert "activate-card: Activate the card." in instructions
    assert "faq: Answer FAQs." in instructions


def test_skills_path_input_wires_through_the_agent(tmp_path: Path) -> None:
    skill_dir = tmp_path / "activate-card"
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text(
        "---\ndescription: Activate the card.\n---\nSTEP 1.\n", encoding="utf-8"
    )
    body = start_body(instructions="You are Alex.", skills=tmp_path)

    assert "activate-card: Activate the card." in body["agent"]["instructions"]
    assert "cosmo_sdk_load_skill" in [t["name"] for t in body["agent"]["tools"]]


def test_skills_menu_is_sole_instructions_when_none_supplied() -> None:
    body = start_body(skills=_skills())
    assert body["agent"]["instructions"].startswith("## Skills")


def test_caller_tool_named_cosmo_sdk_load_skill_is_rejected() -> None:
    # The SDK's own load-skill tool now lives in the reserved cosmo_sdk_
    # namespace, so a caller tool taking that name is rejected at session-config
    # assembly — it never silently drops the skills.
    async def _loader(args: dict[str, Any]) -> dict[str, Any]:
        return {}

    caller_tool = ClientTool(
        name="cosmo_sdk_load_skill",
        description="caller's own loader",
        parameters={"type": "object", "properties": {}},
        handler=_loader,
    )
    with pytest.raises(ValueError, match="reserved"):
        start_body(instructions="You are Alex.", tools=[caller_tool], skills=_skills())


def test_caller_tool_named_load_skill_coexists_with_skills() -> None:
    # ``load_skill`` is now an ordinary caller name — the SDK moved its tool into
    # the reserved namespace — so a caller tool taking it is left in place and
    # the skills' own cosmo_sdk_load_skill tool and menu still attach.
    async def _loader(args: dict[str, Any]) -> dict[str, Any]:
        return {}

    caller_tool = ClientTool(
        name="load_skill",
        description="caller's own loader",
        parameters={"type": "object", "properties": {}},
        handler=_loader,
    )
    body = start_body(
        instructions="You are Alex.", tools=[caller_tool], skills=_skills()
    )

    tool_names = [t["name"] for t in body["agent"]["tools"]]
    assert "load_skill" in tool_names
    assert "cosmo_sdk_load_skill" in tool_names
    assert body["agent"]["instructions"].startswith("You are Alex.\n\n## Skills")


def test_empty_skills_list_adds_no_tool_or_menu() -> None:
    body = start_body(instructions="You are Alex.", skills=[])
    assert body["agent"]["instructions"] == "You are Alex."
    assert "tools" not in body["agent"]  # no load_skill, nothing else declared
