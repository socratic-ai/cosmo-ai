"""
Reads the coaching skill file as three separately-addressable layers per fault.

The split matters because the two Layer 2 passes must not see the same thing.
The audit pass gets only "visual verification tells you" — what to look for
with eyes. Giving it the geometry layer would hand it the segmenter's failure
modes and metric formulas, which is exactly the anchoring the independent pass
exists to avoid: an auditor told how the thing it is auditing breaks stops
being an independent witness.
"""
import re
from dataclasses import dataclass
from pathlib import Path

FAULT_HEADING_RE = re.compile(r"^### (\d+)\.\s+(.+)$", re.MULTILINE)

LAYER_MARKERS: dict[str, str] = {
    "geometry": "**Geometry tells you:",
    "visual": "**Visual verification tells you:",
    "education": "**Education:**",
}


@dataclass(frozen=True)
class FaultSection:
    number: int
    name: str
    geometry: str
    visual: str
    education: str


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", text.replace("**", "")).strip()


def _split_layers(body: str) -> dict[str, str]:
    hits: list[tuple[int, str]] = []
    for layer, marker in LAYER_MARKERS.items():
        idx = body.find(marker)
        if idx >= 0:
            hits.append((idx, layer))
    hits.sort()

    out: dict[str, str] = {}
    for i, (start, layer) in enumerate(hits):
        end = hits[i + 1][0] if i + 1 < len(hits) else len(body)
        out[layer] = _clean(body[start:end])
    return out


def load_fault_sections(skill_path: Path) -> list[FaultSection]:
    if not skill_path.is_file():
        return []

    text = skill_path.read_text()
    matches = list(FAULT_HEADING_RE.finditer(text))

    sections: list[FaultSection] = []
    for i, m in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        # A "## " heading closes the fault list; anything after it is a
        # different section of the skill, not part of the last fault.
        body = text[m.end():end]
        next_h2 = re.search(r"^## ", body, re.MULTILINE)
        if next_h2:
            body = body[:next_h2.start()]

        layers = _split_layers(body)
        sections.append(FaultSection(
            number=int(m.group(1)),
            name=m.group(2).strip(),
            geometry=layers.get("geometry", ""),
            visual=layers.get("visual", ""),
            education=layers.get("education", ""),
        ))
    return sections


def visual_verification_block(sections: list[FaultSection]) -> str:
    """What to look for, per fault — the only skill layer the audit pass may see."""
    lines = [
        f"- {s.name}: {s.visual}"
        for s in sections
        if s.visual
    ]
    if not lines:
        return ""
    return (
        "\n\nWHAT TO LOOK FOR, PER FAULT (from the coaching skill — these describe what "
        "eyes can contribute; they deliberately tell you nothing about how any number is "
        "computed):\n" + "\n".join(lines)
    )


def geometry_and_education_block(sections: list[FaultSection]) -> str:
    """Per-fault measurement caveats and coaching guidance — synthesis pass only."""
    blocks = []
    for s in sections:
        parts = [p for p in (s.geometry, s.education) if p]
        if parts:
            blocks.append(f"- {s.name}\n  " + "\n  ".join(parts))
    if not blocks:
        return ""
    return (
        "\n\nPER-FAULT REFERENCE (from the coaching skill — how each number is derived and "
        "where it lies, plus how to coach it):\n" + "\n\n".join(blocks)
    )
