"""Skills: SKILL.md parsing, resolving the ``skills`` argument (directory
detection, inline lists), the resident menu, and the cosmo_sdk_load_skill tool."""

from __future__ import annotations

from pathlib import Path

import pytest
import structlog.testing
from cosmo_ai.skills._engine import (
    LOAD_SKILL_TOOL_NAME,
    PRIVATE_INSTRUCTIONS_PREFIX,
    Skill,
    SkillParseError,
    build_load_skill_tool,
    menu_text,
    parse_skill_md,
    resolve_skills,
)
from cosmo_ai.tools import ClientTool
from cosmo_ai.tools._sdk_tools import _SdkClientTool

from .fakes import run_awaitable

def test_parses_frontmatter_and_body() -> None:
    text = (
        "---\n"
        "name: activate-card\n"
        "description: Walk the customer through activating their card.\n"
        "---\n"
        "Acknowledge they want to activate. Ask web or app.\n"
    )
    skill = parse_skill_md(text, default_name="ignored")
    assert skill.name == "activate-card"
    assert skill.description == "Walk the customer through activating their card."
    assert skill.body == "Acknowledge they want to activate. Ask web or app."


def test_name_defaults_to_dir_name_when_absent() -> None:
    text = "---\ndescription: A skill.\n---\nBody here.\n"
    skill = parse_skill_md(text, default_name="leave-voicemail")
    assert skill.name == "leave-voicemail"


def test_parses_crlf_and_block_list_frontmatter() -> None:
    # Windows-authored files and YAML block lists under ignored keys
    # (allowed-tools) are valid Agent Skills documents.
    text = (
        "---\r\n"
        "name: activate-card\r\n"
        "description: Activate a card.\r\n"
        "allowed-tools:\r\n"
        "  - Bash\r\n"
        "  - Read\r\n"
        "---\r\n"
        "Body line.\r\n"
    )
    skill = parse_skill_md(text, default_name="ignored")
    assert skill.name == "activate-card"
    assert skill.description == "Activate a card."
    assert skill.body == "Body line."


def test_unknown_frontmatter_keys_are_ignored() -> None:
    # Files authored for other harnesses (tier, allowed-tools, license, …)
    # stay valid; only name/description are read.
    text = (
        "---\n"
        "description: d\n"
        "tier: search\n"
        "allowed-tools: [a, b]\n"
        "license: MIT\n"
        "---\n"
        "body"
    )
    skill = parse_skill_md(text, default_name="x")
    assert skill == Skill(name="x", description="d", body="body")


def test_missing_frontmatter_raises() -> None:
    with pytest.raises(SkillParseError):
        parse_skill_md("Just a body, no frontmatter.", default_name="x")


def test_missing_description_raises() -> None:
    with pytest.raises(SkillParseError):
        parse_skill_md("---\nname: x\n---\nbody", default_name="x")


def test_description_with_colon_is_preserved() -> None:
    text = "---\ndescription: Use this: when X happens.\n---\nbody"
    skill = parse_skill_md(text, default_name="x")
    assert skill.description == "Use this: when X happens."


def test_duplicate_frontmatter_key_raises() -> None:
    text = "---\ndescription: first.\ndescription: second.\n---\nbody"
    with pytest.raises(SkillParseError, match="duplicate"):
        parse_skill_md(text, default_name="x")


def _write_skill(root: Path, dir_name: str, body: str = "Body.") -> None:
    skill_dir = root / dir_name
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        f"---\ndescription: {dir_name} desc.\n---\n{body}\n", encoding="utf-8"
    )


def test_resolve_none_is_none() -> None:
    assert resolve_skills(None) is None


def test_resolve_scans_a_root_of_skill_folders(tmp_path: Path) -> None:
    root = tmp_path / "skills"
    _write_skill(root, "activate-card")
    _write_skill(root, "leave-voicemail")
    (root / "not-a-skill").mkdir()  # no SKILL.md -> ignored

    skills = resolve_skills(root)

    assert skills is not None
    assert [s.name for s in skills] == ["activate-card", "leave-voicemail"]


def test_resolve_accepts_a_str_path(tmp_path: Path) -> None:
    _write_skill(tmp_path / "skills", "faq")
    skills = resolve_skills(str(tmp_path / "skills"))
    assert skills == (Skill(name="faq", description="faq desc.", body="Body."),)


def test_resolve_detects_a_single_skill_directory(tmp_path: Path) -> None:
    # A directory whose own SKILL.md exists IS the skill (one level deeper
    # than the root) — detection, not an error.
    _write_skill(tmp_path, "activate-card")
    skills = resolve_skills(tmp_path / "activate-card")
    assert skills is not None
    assert [s.name for s in skills] == ["activate-card"]


def test_resolve_missing_path_raises(tmp_path: Path) -> None:
    with pytest.raises(SkillParseError, match="not a directory"):
        resolve_skills(tmp_path / "does-not-exist")


def test_resolve_empty_directory_warns_and_attaches_none(tmp_path: Path) -> None:
    # A per-user skills folder that hasn't been populated yet is a valid
    # state, not an error — but it leaves a breadcrumb.
    with structlog.testing.capture_logs() as logs:
        skills = resolve_skills(tmp_path)
    assert skills == ()
    assert any(log["event"] == "realtime.skills.none_found" for log in logs)


def test_resolve_malformed_skill_raises_with_its_path(tmp_path: Path) -> None:
    root = tmp_path / "skills"
    _write_skill(root, "good")
    bad = root / "bad"
    bad.mkdir()
    (bad / "SKILL.md").write_text("no frontmatter here", encoding="utf-8")

    with pytest.raises(SkillParseError, match=r"bad[/\\]SKILL\.md"):
        resolve_skills(root)


def test_resolve_duplicate_names_raise(tmp_path: Path) -> None:
    root = tmp_path / "skills"
    _write_skill(root, "a")
    override = root / "b"
    override.mkdir()
    (override / "SKILL.md").write_text(
        "---\nname: a\ndescription: shadows a.\n---\nbody", encoding="utf-8"
    )
    with pytest.raises(SkillParseError, match="duplicate skill name"):
        resolve_skills(root)


def test_resolve_passes_skill_lists_through() -> None:
    inline = [Skill(name="inline", description="In code.", body="b")]
    assert resolve_skills(inline) == tuple(inline)


def test_resolve_expands_path_elements_in_place(tmp_path: Path) -> None:
    # Built-in skills in code + a user skills folder, one list.
    _write_skill(tmp_path / "user-skills", "from-disk")
    builtin = Skill(name="builtin", description="In code.", body="b")

    skills = resolve_skills([builtin, tmp_path / "user-skills"])

    assert skills is not None
    assert [s.name for s in skills] == ["builtin", "from-disk"]


def test_resolve_duplicate_names_across_elements_raise(tmp_path: Path) -> None:
    _write_skill(tmp_path / "user-skills", "faq")
    inline = Skill(name="faq", description="In code.", body="b")
    with pytest.raises(SkillParseError, match="duplicate skill name"):
        resolve_skills([inline, tmp_path / "user-skills"])


def test_resolve_rejects_non_skill_non_path_elements() -> None:
    with pytest.raises(TypeError, match="must be Skill or a path"):
        resolve_skills([42])  # type: ignore[list-item]


def test_menu_text_lists_all_skills() -> None:
    skills = [
        Skill(name="activate-card", description="Activate the card.", body="b1"),
        Skill(name="leave-voicemail", description="Leave a voicemail.", body="b2"),
    ]
    menu = menu_text(skills)
    assert "activate-card: Activate the card." in menu
    assert "leave-voicemail: Leave a voicemail." in menu


def test_menu_text_empty_when_no_skills() -> None:
    assert menu_text([]) == ""


def _skills() -> list[Skill]:
    return [
        Skill(
            name="activate-card",
            description="Activate the card.",
            body="STEP 1: ask web or app.",
        ),
        Skill(name="faq", description="Answer FAQs.", body="The fee is $5."),
    ]


def test_build_tool_declares_load_skill_with_name_enum() -> None:
    tool = build_load_skill_tool(_skills())
    # An _SdkClientTool (not a bare ClientTool) so the reserved-namespace guard
    # exempts the SDK's own tool by type.
    assert isinstance(tool, _SdkClientTool)
    assert tool.name == LOAD_SKILL_TOOL_NAME == "cosmo_sdk_load_skill"
    assert tool.parameters["properties"]["name"]["enum"] == ["activate-card", "faq"]
    assert tool.parameters["required"] == ["name"]


def test_handler_returns_body_wrapped_in_private_envelope() -> None:
    tool = build_load_skill_tool(_skills())
    assert tool is not None and tool.handler is not None
    result = run_awaitable(tool.handler({"name": "activate-card"}))
    assert result == {
        "instructions": PRIVATE_INSTRUCTIONS_PREFIX + "STEP 1: ask web or app."
    }


def test_handler_raises_on_unknown_skill() -> None:
    tool = build_load_skill_tool(_skills())
    assert tool is not None and tool.handler is not None
    with pytest.raises(ValueError, match="unknown skill"):
        run_awaitable(tool.handler({"name": "nope"}))


def test_build_tool_returns_none_when_no_skills() -> None:
    assert build_load_skill_tool([]) is None
