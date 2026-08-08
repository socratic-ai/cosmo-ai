"""
Build a 1 fps "summary video" for the VLM.

Gemini samples video at roughly 1 fps regardless of what you send, so sending
30 fps means ~29 of every 30 frames are discarded by a sampler we don't
control. This instead makes that choice deliberate:

  - MediaPipe still runs at FULL framerate upstream, so no measurement is lost.
  - Each 1-second bucket is AGGREGATED (min/max/mean over every frame in it),
    not sampled — the caption carries what the full-rate analysis found.
  - One representative frame per second is emitted, captioned with its own
    true timestamp, which makes temporal alignment self-describing rather
    than something the model has to infer against an internal clock.

Representative frame = the deepest point (max knee flexion) in that second.
For squat analysis the bottom position is where faults are visible; a middle
frame would be temporally neutral but diagnostically emptier.
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np

BG = (28, 26, 23)
INK = (232, 226, 212)
ACCENT = (205, 214, 143)
DIM = (150, 145, 130)
ALERT = (120, 140, 220)


def fit_scale(text: str, width: int, base: float, pad: int = 28) -> float:
    """Shrink a caption line until it fits the frame width. Portrait clips are
    narrow enough that a fixed scale silently clips the right edge."""
    scale = base
    while scale > 0.22:
        (tw, _), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, scale, 1)
        if tw <= width - pad:
            return scale
        scale -= 0.02
    return scale


def put_fitted(canvas, text: str, org, width: int, base: float, color) -> None:
    cv2.putText(canvas, text, org, cv2.FONT_HERSHEY_SIMPLEX,
                fit_scale(text, width, base), color, 1, cv2.LINE_AA)


def _reencode(raw_path: str, final_path: str, fps: float) -> None:
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-r", str(fps), "-i", raw_path,
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
         "-r", str(fps), final_path],
        check=True,
    )
    Path(raw_path).unlink(missing_ok=True)


def aggregate_bucket(rows: list) -> dict:
    """Collapse one second of full-rate metrics into what the caption shows."""
    usable = [r for r in rows if r.get("visible")]
    if not usable:
        return {"usable": False, "n_frames": len(rows)}
    flex = [r["knee_flexion_deg"] for r in usable]
    lean = [r["torso_lean_deg"] for r in usable]
    conf = [r.get("landmark_conf", 0) for r in usable]
    agg = {
        "usable": True,
        "n_frames": len(rows),
        "n_usable": len(usable),
        "knee_flex_min": round(min(flex), 1),
        "knee_flex_max": round(max(flex), 1),
        "torso_lean_max": round(max(lean), 1),
        "conf_min": round(min(conf), 2),
        "conf_mean": round(float(np.mean(conf)), 2),
    }
    for key, out in (("heel_rise_norm", "heel_rise_max"), ("knee_over_toe_norm", "knee_over_toe_max")):
        vals = [r[key] for r in usable if r.get(key) is not None]
        if vals:
            agg[out] = round(max(vals), 2)
    return agg


def render(video_path: str, metrics: list, out_path: str, target_fps: float, include_labels: bool,
           scene_state: dict | None, frame_pick: str = "deepest") -> dict:
    cap = cv2.VideoCapture(video_path)
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    frames = []
    while cap.isOpened():
        ok, frame = cap.read()
        if not ok:
            break
        frames.append(frame)
    cap.release()

    by_frame = {m["frame"]: m for m in metrics}
    bucket_ms = int(1000 / target_fps)
    buckets: dict[int, list] = {}
    for i in range(len(frames)):
        m = by_frame.get(i, {"frame": i, "t_ms": int(i * 1000 / src_fps), "visible": False})
        buckets.setdefault(m["t_ms"] // bucket_ms, []).append((i, m))

    rep_bottoms = {}
    if scene_state:
        for e in scene_state.get("events", []):
            rep_bottoms[e["t_ms"] // bucket_ms] = e["rep_id"]

    panel_h = max(116, int(h * 0.30))
    raw_out = out_path + ".raw.mp4"
    writer = cv2.VideoWriter(raw_out, cv2.VideoWriter_fourcc(*"mp4v"), target_fps, (w, h + panel_h))

    manifest = []
    for b in sorted(buckets):
        items = buckets[b]
        rows = [m for _, m in items]
        agg = aggregate_bucket(rows)

        usable_items = [(i, m) for i, m in items if m.get("visible")]
        if frame_pick == "deepest" and usable_items:
            idx, chosen = max(usable_items, key=lambda im: im[1]["knee_flexion_deg"])
        else:
            # "middle" is temporally neutral. Picking the deepest frame makes
            # EVERY second look maximally squat-like — including seconds that
            # are not reps at all (unracking, setup), which hides exactly the
            # evidence a reviewer needs to notice they aren't reps.
            idx, chosen = items[len(items) // 2]

        canvas = cv2.copyMakeBorder(frames[idx], 0, panel_h, 0, 0, cv2.BORDER_CONSTANT, value=BG)
        y = h + 26
        header = f"t = {chosen['t_ms']/1000:.1f}s"
        if include_labels and b in rep_bottoms:
            header += f"   [rep {rep_bottoms[b]} bottom]"
        put_fitted(canvas, header, (12, y), w, 0.55, ACCENT)

        if agg["usable"]:
            lines = [
                (f"knee flex {agg['knee_flex_min']}-{agg['knee_flex_max']}deg", 0.46, INK),
                (f"torso lean max {agg['torso_lean_max']}deg", 0.46, INK),
            ]
            extras = []
            if "heel_rise_max" in agg:
                extras.append(f"heel rise {agg['heel_rise_max']}")
            if "knee_over_toe_max" in agg:
                extras.append(f"knee-over-toe {agg['knee_over_toe_max']}")
            if extras:
                lines.append(("  ".join(extras), 0.40, DIM))
            lines.append((f"conf {agg['conf_min']}-{agg['conf_mean']}  ({agg['n_usable']}/{agg['n_frames']} frames ok)", 0.36, DIM))
            for i, (text, base, color) in enumerate(lines):
                put_fitted(canvas, text, (12, y + 24 + i * 20), w, base, color)
        else:
            put_fitted(canvas, "pose tracking FAILED this second", (12, y + 24), w, 0.44, ALERT)
            put_fitted(canvas, "treat any reading here as unreliable", (12, y + 44), w, 0.40, ALERT)

        writer.write(canvas)
        manifest.append({"t_ms": chosen["t_ms"], **agg})

    writer.release()
    _reencode(raw_out, out_path, target_fps)
    return {"n_output_frames": len(manifest), "source_fps": src_fps, "target_fps": target_fps,
            "buckets": manifest}


def main():
    p = argparse.ArgumentParser(description="Build a 1fps captioned summary video for VLM input.")
    p.add_argument("--video", required=True, help="source video (raw or overlay)")
    p.add_argument("--metrics", required=True)
    p.add_argument("--scene-state", default=None)
    p.add_argument("--out", required=True)
    p.add_argument("--target-fps", type=float, default=1.0)
    p.add_argument("--include-rep-labels", action="store_true",
                   help="stamp 'rep N bottom'. Off by default: labeling frames the VLM should "
                        "independently judge is what lets it catch Layer 1 segmentation errors.")
    p.add_argument("--frame-pick", choices=["deepest", "middle"], default="deepest",
                   help="which frame represents each second (see render() for why this matters)")
    p.add_argument("--manifest-out", default=None)
    args = p.parse_args()

    metrics = json.loads(Path(args.metrics).read_text())
    scene_state = json.loads(Path(args.scene_state).read_text()) if args.scene_state else None
    info = render(args.video, metrics, args.out, args.target_fps, args.include_rep_labels,
                  scene_state, frame_pick=args.frame_pick)

    if args.manifest_out:
        Path(args.manifest_out).write_text(json.dumps(info, indent=2))
    print(f"wrote {args.out}: {info['n_output_frames']} frames "
          f"({info['source_fps']:.0f}fps -> {info['target_fps']}fps)", file=sys.stderr)


if __name__ == "__main__":
    main()
