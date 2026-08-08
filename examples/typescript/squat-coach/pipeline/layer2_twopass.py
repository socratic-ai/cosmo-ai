"""
Two-pass Layer 2.

Pass A — AUDIT (independent). Raw video, bare rep timestamps, no Layer 1
numbers. Blindness is the point: it is what lets this pass contradict Layer 1
rather than agree with it. In testing it flagged that two of Layer 1's "reps"
were actually the unrack phase.

Pass B — SYNTHESIS (fully informed). Layer 1's full metrics + Pass A's findings
+ the video. Anchoring is fine here because this pass isn't judging whether
Layer 1 is right; it's writing the final answer from everything available,
including where the two disagree.

The split exists because those two jobs have opposite information needs, and
one call can't serve both. They stay two isolated calls rather than two turns
of one conversation for the same reason: pass B must read pass A as a
stranger's report, not as something it wrote.

The video is uploaded once into an explicit cache that both calls reference,
which is what makes running two calls cost about as much wall time as one.
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from google import genai
from google.genai import types

from layer2_narrator import (
    MODEL,
    RESPONSE_SCHEMA,
    PROMPT_TEMPLATE,
    build_rep_timeline,
    build_rep_windows,
    attach_rep_ids,
)
from skill_sections import (
    FaultSection,
    load_fault_sections,
    visual_verification_block,
    geometry_and_education_block,
)

# Inline request parts cap out around 20MB. Phone footage clears that easily
# (a 60s 1080p clip runs 50-100MB), so shrink before sending rather than
# letting the call fail on exactly the videos people actually record.
MAX_INLINE_BYTES = 15 * 1024 * 1024

SKILL_PATH = Path(__file__).resolve().parent.parent / "skills" / "squat" / "SKILL.md"

CACHE_TTL_SECONDS = 600

THINKING_BUDGET = 1024

FINAL_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "session_summary": {"type": "STRING", "description": "2-3 sentences a coach would open with"},
        "reliability": {
            "type": "OBJECT",
            "properties": {
                "reps_trustworthy": {"type": "ARRAY", "items": {"type": "INTEGER"}},
                "reps_disputed": {"type": "ARRAY", "items": {"type": "INTEGER"}},
                "note": {"type": "STRING"},
            },
            "required": ["reps_trustworthy", "reps_disputed", "note"],
        },
        "findings": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "title": {"type": "STRING"},
                    "detail": {"type": "STRING", "description": "what to tell the user, in plain coaching language"},
                    "source": {"type": "STRING", "enum": ["measured", "visual", "both"]},
                    "rep_ids": {"type": "ARRAY", "items": {"type": "INTEGER"}},
                    "start_ms": {"type": "INTEGER"},
                    "end_ms": {"type": "INTEGER"},
                    "confidence": {"type": "STRING", "enum": ["low", "medium", "high"]},
                    "priority": {"type": "INTEGER", "description": "1 = most important to raise first"},
                },
                "required": ["title", "detail", "source", "rep_ids", "confidence", "priority"],
            },
        },
        "disagreements": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "what": {"type": "STRING"},
                    "resolution": {"type": "STRING", "description": "which source to trust here, and why"},
                },
                "required": ["what", "resolution"],
            },
        },
    },
    "required": ["session_summary", "reliability", "findings", "disagreements"],
}

SYNTHESIS_PROMPT = """You are writing the final analysis of a squat set. It will be handed to a \
voice coach that talks to the lifter and can replay video clips — so it must be accurate, \
prioritized, and honest about uncertainty.

You have three inputs, with different authority:

1. MEASURED DATA (below) — from deterministic pose tracking at full framerate. Authoritative for \
what it measures: joint angles, depth, tempo, heel rise, knee travel, asymmetry. It CANNOT see \
spine curvature (no spine landmark exists), and it cannot tell whether a detected "rep" was \
really a rep — it just follows knee-angle thresholds.

2. INDEPENDENT VISUAL REVIEW (below) — a separate pass that watched the raw footage WITHOUT \
seeing any of the measured numbers, specifically so it could disagree. Authoritative for things \
geometry can't represent (spine rounding, butt wink) and for flagging when a "rep" wasn't a rep. \
Its timestamps are approximate.

3. THE VIDEO ITSELF (attached) — use it to adjudicate where the two disagree.

Your job:
- Where the visual review disputes a rep, TRUST IT over the measured data, and put those rep ids \
in reps_disputed. Measured numbers from a non-rep are meaningless, however precise they look.
- Never restate a measured number that came from a disputed rep as if it were real.
- Merge the rest: numbers give precision, visual review gives the things numbers can't see.
- Prioritize. A lifter can act on two or three things, not ten. priority 1 = say this first.
- Set source honestly: "measured" (from numbers), "visual" (only the review saw it), "both".
- Write detail in plain coaching language — what to actually say to the person.
- If something is uncertain, say so in the detail rather than dropping it or overstating it.
{skill_reference}

MEASURED DATA:
{layer1_json}

INDEPENDENT VISUAL REVIEW:
{pass_a_json}
"""

OVERLAY_NOTE = """

A SECOND copy of the same footage is also attached, with the pose skeleton drawn on it. The \
skeleton is what the measurement system saw, not ground truth — in particular it draws the torso \
as a straight line whether or not the real back was straight. Use it to check landmark tracking, \
never as evidence about spine shape."""


def video_part(path: str) -> types.Part:
    data = Path(path).read_bytes()
    if len(data) <= MAX_INLINE_BYTES:
        return types.Part.from_bytes(data=data, mime_type="video/mp4")

    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp:
        shrunk = tmp.name
    # 720p and a lower bitrate is plenty — Gemini samples ~1fps anyway.
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", path,
         "-vf", "scale='min(1280,iw)':-2", "-c:v", "libx264", "-crf", "30",
         "-preset", "veryfast", "-an", "-movflags", "+faststart", shrunk],
        check=True,
    )
    data = Path(shrunk).read_bytes()
    Path(shrunk).unlink(missing_ok=True)
    print(f"  downscaled for upload: {Path(path).name} -> {len(data) // 1024}KB", file=sys.stderr)
    return types.Part.from_bytes(data=data, mime_type="video/mp4")


def create_video_cache(client: genai.Client, raw_video: str) -> types.CachedContent:
    return client.caches.create(
        model=MODEL,
        config=types.CreateCachedContentConfig(
            contents=[types.Content(role="user", parts=[video_part(raw_video)])],
            ttl=f"{CACHE_TTL_SECONDS}s",
            display_name="squat-coach-raw-video",
        ),
    )


def usage_row(response: types.GenerateContentResponse) -> dict[str, int]:
    u = response.usage_metadata
    return {
        "prompt_tokens": u.prompt_token_count or 0,
        "cached_tokens": u.cached_content_token_count or 0,
        "thoughts_tokens": u.thoughts_token_count or 0,
        "output_tokens": u.candidates_token_count or 0,
        "total_tokens": u.total_token_count or 0,
    }


def run_pass_a(
    client: genai.Client,
    cache_name: str,
    scene_state: dict,
    sections: list[FaultSection],
) -> tuple[dict, dict[str, int]]:
    prompt = PROMPT_TEMPLATE.format(rep_timeline=build_rep_timeline(scene_state))
    prompt += visual_verification_block(sections)
    response = client.models.generate_content(
        model=MODEL,
        contents=[types.Content(role="user", parts=[types.Part.from_text(text=prompt)])],
        config=types.GenerateContentConfig(
            cached_content=cache_name,
            response_mime_type="application/json",
            response_schema=RESPONSE_SCHEMA,
            thinking_config=types.ThinkingConfig(thinking_budget=THINKING_BUDGET),
        ),
    )
    return attach_rep_ids(json.loads(response.text), scene_state), usage_row(response)


def run_pass_b(
    client: genai.Client,
    cache_name: str,
    scene_state: dict,
    pass_a: dict,
    sections: list[FaultSection],
    overlay_video: str | None,
) -> tuple[dict, dict[str, int]]:
    prompt = SYNTHESIS_PROMPT.format(
        skill_reference=geometry_and_education_block(sections),
        layer1_json=json.dumps(scene_state, indent=2),
        pass_a_json=json.dumps(pass_a, indent=2),
    )
    parts: list[types.Part] = []
    if overlay_video:
        parts.append(video_part(overlay_video))
        prompt += OVERLAY_NOTE
    parts.append(types.Part.from_text(text=prompt))

    response = client.models.generate_content(
        model=MODEL,
        contents=[types.Content(role="user", parts=parts)],
        config=types.GenerateContentConfig(
            cached_content=cache_name,
            response_mime_type="application/json",
            response_schema=FINAL_SCHEMA,
            thinking_config=types.ThinkingConfig(thinking_budget=THINKING_BUDGET),
        ),
    )
    return json.loads(response.text), usage_row(response)


def segmentation_disputed_reps(pass_a: dict, scene_state: dict) -> set[int]:
    """Reps whose window overlaps a pass-A segmentation_concern."""
    windows = build_rep_windows(scene_state)
    disputed: set[int] = set()
    for obs in pass_a.get("observations", []):
        if obs.get("finding_type") != "segmentation_concern":
            continue
        for start, end, rep_id in windows:
            if obs["start_ms"] < end and obs["end_ms"] > start:
                disputed.add(rep_id)
        if obs.get("rep_id") is not None:
            disputed.add(obs["rep_id"])
    return disputed


def enforce_disputes(final: dict, pass_a: dict, scene_state: dict) -> list[int]:
    """Audit segmentation concerns may never vanish silently. Returns the reps affected.

    Not a hard union: at capped thinking the audit's segmentation calls are
    unreliable (regression probes saw both misses and phantom rep ids), and a
    forced union would let one noisy observation irrevocably delete a real
    rep's measurements. Synthesis — which sees the video, the timeline, and the
    audit — is empirically the reliable disputer, so its disputed set stands;
    any audit concern it did not adopt is surfaced as an unresolved
    disagreement for the coach to speak to honestly."""
    reliability = final["reliability"]
    from_model = set(reliability.get("reps_disputed") or [])
    from_audit = segmentation_disputed_reps(pass_a, scene_state)
    reliability["reps_disputed"] = sorted(from_model)
    reliability["reps_trustworthy"] = sorted(set(reliability.get("reps_trustworthy") or []) - from_model)

    unadopted = sorted(from_audit - from_model)
    if unadopted:
        final.setdefault("disagreements", []).append({
            "what": (
                f"The independent visual review raised a segmentation concern touching "
                f"rep(s) {', '.join(str(r) for r in unadopted)}, but the synthesis pass kept them."
            ),
            "resolution": (
                "Unresolved — treat these reps' numbers as usable but mention the doubt "
                "if they come up."
            ),
        })
    return unadopted


def main() -> None:
    p = argparse.ArgumentParser(description="Two-pass Layer 2: independent audit, then informed synthesis.")
    p.add_argument("--raw-video", required=True, help="clean footage — cached, seen by both passes")
    p.add_argument("--overlay-video", default=None,
                   help="skeleton overlay; attached to pass B only when SQUAT_COACH_SYNTH_OVERLAY=1")
    p.add_argument("--scene-state", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--pass-a-out", default=None, help="also write pass A's raw findings")
    args = p.parse_args()

    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        print("GEMINI_API_KEY not set", file=sys.stderr)
        sys.exit(1)

    client = genai.Client(api_key=api_key)
    scene_state = json.loads(Path(args.scene_state).read_text())
    sections = load_fault_sections(SKILL_PATH)
    if not sections:
        print(f"  no skill sections found at {SKILL_PATH} — running without skill context", file=sys.stderr)

    synth_overlay = args.overlay_video if os.getenv("SQUAT_COACH_SYNTH_OVERLAY") == "1" else None

    started = time.monotonic()
    cache = create_video_cache(client, args.raw_video)
    try:
        print("pass A (independent audit)...", file=sys.stderr)
        pass_a, usage_a = run_pass_a(client, cache.name, scene_state, sections)
        if args.pass_a_out:
            Path(args.pass_a_out).write_text(json.dumps(pass_a, indent=2))

        print(f"pass B (informed synthesis{', +overlay' if synth_overlay else ''})...", file=sys.stderr)
        final, usage_b = run_pass_b(client, cache.name, scene_state, pass_a, sections, synth_overlay)
    finally:
        client.caches.delete(name=cache.name)

    restored = enforce_disputes(final, pass_a, scene_state)
    if restored:
        print(f"  code-enforced disputes restored: {restored}", file=sys.stderr)

    final["_pass_a"] = pass_a
    final["_usage"] = {"pass_a": usage_a, "pass_b": usage_b}
    final["_elapsed_s"] = round(time.monotonic() - started, 2)

    Path(args.out).write_text(json.dumps(final, indent=2))
    print(f"wrote {args.out} in {final['_elapsed_s']}s", file=sys.stderr)


if __name__ == "__main__":
    main()
