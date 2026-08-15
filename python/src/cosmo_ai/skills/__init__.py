"""Skills for the realtime SDK: SKILL.md files (the Agent Skills standard)
loaded just-in-time via a single ``cosmo_sdk_load_skill`` tool, with the skill
menu resident in the prompt.

Attach skills with the ``skills`` argument on :meth:`RealtimeClient.agent` — a
directory, or a list whose elements are directories and/or inline
:class:`Skill` objects. See :mod:`cosmo_ai.skills._engine` for the
directory-detection and error semantics.
"""

from cosmo_ai.skills._engine import Skill, SkillParseError, SkillsInput

__all__ = ["Skill", "SkillParseError", "SkillsInput"]
