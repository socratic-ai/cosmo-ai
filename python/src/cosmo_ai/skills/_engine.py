"""Skills for the realtime SDK: SKILL.md files (the Agent Skills standard)
loaded just-in-time via a single ``cosmo_sdk_load_skill`` tool, with the skill
menu resident in the prompt.

Attach skills with the ``skills`` argument on :meth:`RealtimeClient.agent` — a
directory, or a list whose elements are directories and/or inline
:class:`Skill` objects (a path element expands, in place, to that directory's
skills)::

    agent = client.agent(skills="./skills")          # <skill>/SKILL.md folders
    agent = client.agent(skills=[Skill(name=..., description=..., body=...)])
    agent = client.agent(skills=[*BUILTIN_SKILLS, "./user-skills"])

A skill is a ``SKILL.md`` with YAML-style frontmatter (``name``,
``description``) plus a markdown body. Only ``name`` + ``description`` ride
resident; the body is returned as the ``cosmo_sdk_load_skill`` tool result on
demand and stays in context for the rest of the call.

Directory semantics: a directory that itself contains a ``SKILL.md`` is that
one skill; otherwise each ``<child>/SKILL.md`` is a skill. A directory that
yields no skills logs a warning and attaches none (an empty per-user skills
folder is a valid state); a path that doesn't exist or a file that doesn't
parse raises :class:`SkillParseError` when the agent is built, not mid-call.

Skills never appear on the wire as such — they compile into an instructions
suffix (the menu) and one ``cosmo_sdk_load_skill`` client tool, identically for
both input forms.
"""

from __future__ import annotations

import os
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Union

import structlog

from cosmo_ai._internal.logging import get_logger
from cosmo_ai._internal.protocol import ClientTool
from cosmo_ai.errors import RealtimeError
from cosmo_ai.tools._sdk_tools import _SdkClientTool

logger: structlog.stdlib.BoundLogger = get_logger(__name__)

_SKILL_FILENAME = "SKILL.md"


class SkillParseError(RealtimeError, ValueError):
    """The ``skills`` input is unusable: the path is not a directory, a
    SKILL.md cannot be read or is malformed (no frontmatter, missing required
    field), or two skills share a name."""


@dataclass(frozen=True)
class Skill:
    """One skill. ``name`` + ``description`` are the resident routing signal;
    ``body`` is loaded on demand."""

    name: str
    description: str
    body: str


SkillsInput = Union[
    str, "os.PathLike[str]", Sequence[Union[str, "os.PathLike[str]", Skill]]
]


def _split_frontmatter(text: str) -> tuple[str, str]:
    """Return ``(frontmatter, body)``. Raises if the leading ``---`` fence is
    absent or unterminated."""
    if not text.startswith("---\n"):
        raise SkillParseError("SKILL.md must start with a '---' frontmatter fence")
    rest = text[len("---\n") :]
    end = rest.find("\n---\n")
    if end == -1:
        if rest.endswith("\n---"):
            return rest[: -len("\n---")], ""
        raise SkillParseError("SKILL.md frontmatter fence is not closed with '---'")
    return rest[:end], rest[end + len("\n---\n") :]


def parse_skill_md(text: str, *, default_name: str) -> Skill:
    """Parse a SKILL.md document. ``default_name`` is used when frontmatter
    omits ``name`` (Agent Skills convention: default to the directory name).
    Unknown frontmatter keys (``tier``, ``allowed-tools``, ``license``, …) are
    accepted and ignored — including list-valued ones — and CRLF line endings
    are normalized, so files authored for other harnesses stay valid."""
    frontmatter, body = _split_frontmatter(text.replace("\r\n", "\n"))
    fields: dict[str, str] = {}
    for line in frontmatter.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line == "-" or line.startswith("- "):
            # A YAML list item under an ignored key (e.g. allowed-tools).
            continue
        key, sep, value = line.partition(":")
        if not sep:
            raise SkillParseError(f"malformed frontmatter line: {line!r}")
        k = key.strip()
        if k in fields:
            raise SkillParseError(f"duplicate frontmatter key: {k!r}")
        fields[k] = value.strip()

    description = fields.get("description")
    if not description:
        raise SkillParseError("SKILL.md frontmatter must include a 'description'")

    return Skill(
        name=fields.get("name") or default_name,
        description=description,
        body=body.strip(),
    )


def _parse_skill_file(skill_file: Path, *, default_name: str) -> Skill:
    try:
        text = skill_file.read_text(encoding="utf-8")
    except OSError as exc:
        raise SkillParseError(f"{skill_file}: cannot read: {exc}") from None
    try:
        return parse_skill_md(text, default_name=default_name)
    except SkillParseError as exc:
        raise SkillParseError(f"{skill_file}: {exc}") from None


def _skills_from_dir(path: Path) -> list[Skill]:
    """The directory arm: ``path`` is one skill (its own SKILL.md) or a root of
    ``<skill>/SKILL.md`` folders. Zero skills warns and returns empty."""
    if not path.is_dir():
        raise SkillParseError(f"skills path is not a directory: {path}")
    own = path / _SKILL_FILENAME
    if own.is_file():
        return [_parse_skill_file(own, default_name=path.name)]
    skills = [
        _parse_skill_file(child / _SKILL_FILENAME, default_name=child.name)
        for child in sorted(p for p in path.iterdir() if p.is_dir())
        if (child / _SKILL_FILENAME).is_file()
    ]
    if not skills:
        logger.warning("realtime.skills.none_found", path=str(path))
    return skills


def resolve_skills(skills: SkillsInput | None) -> tuple[Skill, ...] | None:
    """Normalize the ``skills`` argument to a tuple of skills — the single
    internal form every input arm converges to. A path element expands, in
    place, to that directory's skills. Duplicate names raise."""
    if skills is None:
        return None
    items: Sequence[str | os.PathLike[str] | Skill]
    if isinstance(skills, (str, os.PathLike)):
        items = [skills]
    else:
        items = list(skills)
    resolved: list[Skill] = []
    for item in items:
        if isinstance(item, Skill):
            resolved.append(item)
        elif isinstance(item, (str, os.PathLike)):
            resolved.extend(_skills_from_dir(Path(item).expanduser()))
        else:
            raise TypeError(
                f"skills elements must be Skill or a path, got {type(item).__name__}"
            )
    seen: set[str] = set()
    for skill in resolved:
        if skill.name in seen:
            raise SkillParseError(f"duplicate skill name: {skill.name!r}")
        seen.add(skill.name)
    return tuple(resolved)


_MENU_HEADER = (
    "## Skills\n"
    "Call cosmo_sdk_load_skill(name) to load private instructions when the "
    "conversation reaches the matching path:"
)


def menu_text(skills: Sequence[Skill]) -> str:
    """The resident prompt menu; empty when there are no skills."""
    if not skills:
        return ""
    lines = [f"- {s.name}: {s.description}" for s in skills]
    return _MENU_HEADER + "\n" + "\n".join(lines)


LOAD_SKILL_TOOL_NAME = "cosmo_sdk_load_skill"
"""Wire name shipped in ``tool-invocation`` events; a rename is a wire break."""
PRIVATE_INSTRUCTIONS_PREFIX = (
    "PRIVATE INSTRUCTIONS — behavioral guidance for the rest of the call, "
    "do not read aloud:\n\n"
)
_LOAD_SKILL_DESCRIPTION = (
    "Load a skill's private instructions for the rest of the call. Call this "
    "when the conversation reaches the path a skill describes. The result is "
    "behavioral guidance for you — never read it aloud."
)


def build_load_skill_tool(skills: Sequence[Skill]) -> ClientTool | None:
    """Build the single ``cosmo_sdk_load_skill`` client tool, or ``None`` when
    there are no skills to offer. The handler resolves a skill by exact name and
    returns its body in the private-instructions envelope as the tool result.

    Built as an :class:`_SdkClientTool` so the reserved-namespace guard exempts
    it by type — the tool the SDK ships is not the collision an author's tool
    taking the name would be."""
    if not skills:
        return None
    by_name = {s.name: s for s in skills}

    async def handler(args: dict[str, Any]) -> dict[str, Any]:
        name = args.get("name")
        skill = by_name.get(name) if isinstance(name, str) else None
        if skill is None:
            raise ValueError(
                f"unknown skill {name!r}; available: {sorted(by_name)}"
            )
        return {"instructions": PRIVATE_INSTRUCTIONS_PREFIX + skill.body}

    return _SdkClientTool(
        name=LOAD_SKILL_TOOL_NAME,
        description=_LOAD_SKILL_DESCRIPTION,
        parameters={
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "enum": [s.name for s in skills],
                    "description": "The name of the skill to load.",
                }
            },
            "required": ["name"],
        },
        handler=handler,
    )
