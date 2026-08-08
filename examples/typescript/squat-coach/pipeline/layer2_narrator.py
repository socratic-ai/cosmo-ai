"""
Layer 2: a VLM (Gemini Flash) watching the RAW video to catch what the
deterministic Layer 1 kinematics engine structurally cannot see — chiefly
back/spine rounding, since sparse-landmark pose models (MediaPipe included)
have no spine landmark and model the torso as one rigid shoulder-to-hip
segment.

Design constraints (from independent Codex + Fable review, both converged):
- Sends the RAW video, not the skeleton overlay. The overlay draws a straight
  line exactly where spine-curvature evidence lives, biasing the model toward
  confirming Layer 1's rigid-torso assumption instead of seeing past it.
- Never given Layer 1's numeric findings — only a minimal rep-timing skeleton
  (rep_id, start/bottom/end ms), explicitly told NOT to estimate anything
  Layer 1 already owns (angles, tempo, knee travel, heel rise, asymmetry).
  Otherwise it just parrots or contradicts numbers it was anchored on.
- Findings are timestamp-keyed, not rep_id-keyed — rep_ids on a finding are
  advisory. The authoritative rep join happens downstream in plain code,
  never trusted from the model.
- Abstention is a first-class, required field (visibility), not an absence.
  No finding is emitted for the back unless the model says it could see it.
"""
import base64
import json
import os
import sys
from pathlib import Path

from google import genai
from google.genai import types

MODEL = "gemini-3-flash-preview"

RESPONSE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "video_quality": {
            "type": "OBJECT",
            "properties": {
                "camera_view": {"type": "STRING", "enum": ["side", "front", "rear", "oblique", "unknown"]},
                "back_visibility": {"type": "STRING", "enum": ["clear", "partial", "occluded", "not_visible"]},
            },
            "required": ["camera_view", "back_visibility"],
        },
        "observations": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "finding_type": {
                        "type": "STRING",
                        "enum": ["back_rounding", "butt_wink", "bar_path_drift", "setup_issue", "segmentation_concern", "other"],
                    },
                    "start_ms": {"type": "INTEGER"},
                    "end_ms": {"type": "INTEGER"},
                    "nearest_rep_id_hint": {"type": "INTEGER", "description": "advisory only, not authoritative"},
                    "severity": {"type": "STRING", "enum": ["mild", "moderate", "severe"]},
                    "confidence": {"type": "STRING", "enum": ["low", "medium", "high"]},
                    "visibility": {"type": "STRING", "enum": ["clear", "partial", "occluded"]},
                    "evidence": {"type": "STRING", "description": "one sentence, what was actually seen"},
                },
                "required": ["finding_type", "start_ms", "end_ms", "severity", "confidence", "visibility", "evidence"],
            },
        },
    },
    "required": ["video_quality", "observations"],
}

PROMPT_TEMPLATE = """You are watching a video of someone doing squats, to catch things a joint-angle \
tracking system structurally cannot see. A separate deterministic system already measures, from \
sparse body-joint tracking: knee flexion angle, torso lean angle (as one rigid line), rep tempo, \
heel rise, knee-over-toe travel, head position, left/right knee asymmetry.

Do NOT estimate, re-derive, or report on any of those — you have no advantage there and your \
numbers would just be guesses layered on top of real measurements. Your only job is to look for \
things that a rigid stick-figure skeleton cannot represent, primarily:
- Back/spine rounding — the torso curving rather than staying a straight line, especially near \
  the bottom of a rep. This is invisible to joint-angle tracking because it has no spine landmark.
- Butt wink (pelvis tucking under at the bottom)
- Bar path drift, if a barbell is visible
- Any setup issue (unsafe position, equipment problem)
- If you notice the video itself doing something odd — a cut, a different person appearing, \
  footage that isn't actually a squat — flag that as "segmentation_concern"

This set has approximately these reps (for temporal orientation only — do not treat these \
boundaries as necessarily correct, and flag it as a segmentation_concern if what you see \
disagrees with them):
{rep_timeline}

Be honest about what you can and can't see. If the back isn't visible or is occluded (by an arm, \
by camera angle, by clothing), say so in back_visibility and do not report a back_rounding finding \
for that period — a missing finding is correct and expected when the view doesn't support one. \
Do not report anything as "severe" or "high confidence" unless it is unambiguous in the footage."""


def build_rep_timeline(scene_state: dict) -> str:
    lines = []
    for e in scene_state.get("events", []):
        lines.append(f"  rep {e['rep_id']}: bottom at t={e['t_ms']}ms")
    return "\n".join(lines) if lines else "  (no reps detected by the deterministic system)"


SUMMARY_VIDEO_PREAMBLE = """IMPORTANT — what you are looking at:

This is a 1 frame-per-second SUMMARY video, not real-time footage. Each frame is one
representative moment (the deepest point) from one second of a full-rate 30fps recording,
with a caption panel below it reporting what a pose-tracking system measured across ALL
frames of that second — not just the frame shown.

How to read the caption panel:
- "t = X.Xs" is the true timestamp of the frame shown. Use these for your start_ms/end_ms.
- "knee flex A-Bdeg" is the range across that whole second.
- "conf X-Y (N/M frames ok)" is pose-tracking confidence. LOW confidence or few usable
  frames means the tracking system was struggling there (occlusion, equipment in the way,
  motion blur) — treat measurements in those seconds as unreliable, and say so.

Because motion between consecutive frames is one full second apart, do NOT infer smooth
motion or tempo from frame-to-frame changes. Judge posture and body shape from what is
visible within each frame.

"""


def run_layer2(raw_video_path: str, scene_state: dict, api_key: str, summary_video: bool = False) -> dict:
    client = genai.Client(api_key=api_key)
    video_bytes = Path(raw_video_path).read_bytes()
    prompt = PROMPT_TEMPLATE.format(rep_timeline=build_rep_timeline(scene_state))
    if summary_video:
        prompt = SUMMARY_VIDEO_PREAMBLE + prompt

    response = client.models.generate_content(
        model=MODEL,
        contents=[
            types.Content(
                role="user",
                parts=[
                    types.Part.from_bytes(data=video_bytes, mime_type="video/mp4"),
                    types.Part.from_text(text=prompt),
                ],
            )
        ],
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=RESPONSE_SCHEMA,
        ),
    )
    return json.loads(response.text)


def build_rep_windows(scene_state: dict) -> list[tuple[int, int, int]]:
    """(start_ms, end_ms, rep_id) — the single definition of where a rep lives
    in time. Every timestamp->rep join must go through this."""
    windows: list[tuple[int, int, int]] = []
    events = scene_state.get("events", [])
    for i, e in enumerate(events):
        prev_t = events[i - 1]["t_ms"] if i > 0 else 0
        next_t = events[i + 1]["t_ms"] if i + 1 < len(events) else e["t_ms"] + 5000
        window_start = (prev_t + e["t_ms"]) // 2 if i > 0 else 0
        window_end = (e["t_ms"] + next_t) // 2
        windows.append((window_start, window_end, e["rep_id"]))
    return windows


def attach_rep_ids(layer2_result: dict, scene_state: dict) -> dict:
    """The authoritative timestamp->rep join — done here in plain code, never
    trusted from the model's advisory nearest_rep_id_hint."""
    rep_windows = build_rep_windows(scene_state)
    for obs in layer2_result.get("observations", []):
        mid = (obs["start_ms"] + obs["end_ms"]) // 2
        obs["rep_id"] = next((rid for start, end, rid in rep_windows if start <= mid < end), None)
    return layer2_result


def _cli():
    import argparse

    parser = argparse.ArgumentParser(description="Run Layer 2 (Gemini visual narrator) on a raw video.")
    parser.add_argument("--video", required=True, help="RAW (not overlay) video path")
    parser.add_argument("--scene-state", required=True, help="path to Layer 1's scene_state.json")
    parser.add_argument("--out", default=None, help="output path (default: stdout)")
    parser.add_argument("--summary-video", action="store_true",
                        help="input is a 1fps captioned summary video from build_1fps_summary.py")
    args = parser.parse_args()

    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        print("GEMINI_API_KEY not set", file=sys.stderr)
        sys.exit(1)

    scene_state = json.loads(Path(args.scene_state).read_text())
    result = run_layer2(args.video, scene_state, api_key, summary_video=args.summary_video)
    result = attach_rep_ids(result, scene_state)

    out_text = json.dumps(result, indent=2)
    if args.out:
        Path(args.out).write_text(out_text)
        print(f"wrote {args.out}", file=sys.stderr)
    else:
        print(out_text)


if __name__ == "__main__":
    _cli()
