"""
Coaching SDK spike: capture -> kinematics -> scene-state index, on real video.
No LLM in this pass — proves Layer 01 (deterministic kinematics engine) end to end.
"""
import json
import math
import os
import subprocess
import sys
from pathlib import Path

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks.python import BaseOptions
from mediapipe.tasks.python import vision as mp_vision

LM = mp_vision.PoseLandmark
POSE_CONNECTIONS = mp_vision.PoseLandmarksConnections.POSE_LANDMARKS
MODEL_PATH = str(Path(__file__).parent / "models" / "pose_landmarker_lite.task")

_LANDMARK_COLOR = (0, 255, 140)
_CONNECTION_COLOR = (255, 200, 0)


def draw_landmarks(frame, landmarks, w, h):
    pts = [(int(lm.x * w), int(lm.y * h)) for lm in landmarks]
    for conn in POSE_CONNECTIONS:
        cv2.line(frame, pts[conn.start], pts[conn.end], _CONNECTION_COLOR, 2)
    for p in pts:
        cv2.circle(frame, p, 3, _LANDMARK_COLOR, -1)


def angle_deg(a, b, c):
    """Angle at point b, formed by rays b->a and b->c, in degrees."""
    a, b, c = np.array(a), np.array(b), np.array(c)
    ba = a - b
    bc = c - b
    cos_angle = np.dot(ba, bc) / (np.linalg.norm(ba) * np.linalg.norm(bc) + 1e-9)
    cos_angle = np.clip(cos_angle, -1.0, 1.0)
    return math.degrees(math.acos(cos_angle))


def fppa_deg(hip, knee, ankle):
    """Frontal-plane projection angle: deviation of the knee from the hip-ankle line,
    in the image plane. Only meaningful when the camera is near-frontal to the subject."""
    hip, knee, ankle = np.array(hip), np.array(knee), np.array(ankle)
    line = ankle - hip
    line_norm = line / (np.linalg.norm(line) + 1e-9)
    proj_len = np.dot(knee - hip, line_norm)
    proj_point = hip + proj_len * line_norm
    deviation = knee - proj_point
    signed = deviation[0]  # x-direction deviation, image space
    magnitude = np.linalg.norm(deviation)
    return magnitude, signed


def _reencode_for_browser_playback(raw_path: str, final_path: str) -> None:
    """OpenCV's VideoWriter emits MPEG-4 Part 2 ('mp4v') even inside an .mp4
    container — Chrome's demuxer has no decoder for that codec at all
    (DEMUXER_ERROR_NO_SUPPORTED_STREAMS), regardless of how the JS side waits
    for it. Re-encode to real H.264 so the overlay is actually playable."""
    subprocess.run(
        [
            "ffmpeg", "-y", "-loglevel", "error",
            "-i", raw_path,
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
            final_path,
        ],
        check=True,
    )
    os.remove(raw_path)


def extract_landmarks(video_path: str, overlay_out: str):
    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    raw_overlay_out = overlay_out + ".raw.mp4"
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(raw_overlay_out, fourcc, fps, (w, h))

    options = mp_vision.PoseLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=MODEL_PATH),
        running_mode=mp_vision.RunningMode.VIDEO,
        min_pose_detection_confidence=0.5,
        min_tracking_confidence=0.5,
    )

    frames = []
    with mp_vision.PoseLandmarker.create_from_options(options) as landmarker:
        frame_idx = 0
        while cap.isOpened():
            ok, frame = cap.read()
            if not ok:
                break
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
            timestamp_ms = int(frame_idx * 1000 / fps)
            result = landmarker.detect_for_video(mp_image, timestamp_ms)

            row = {"frame": frame_idx, "t_ms": timestamp_ms, "visible": False, "_frame_w": w}
            if result.pose_landmarks:
                lm = result.pose_landmarks[0]
                row["visible"] = True
                pts = {}
                for name in [
                    "LEFT_HIP", "RIGHT_HIP", "LEFT_KNEE", "RIGHT_KNEE",
                    "LEFT_ANKLE", "RIGHT_ANKLE", "LEFT_SHOULDER", "RIGHT_SHOULDER",
                    "LEFT_HEEL", "RIGHT_HEEL", "LEFT_FOOT_INDEX", "RIGHT_FOOT_INDEX",
                    "LEFT_WRIST", "RIGHT_WRIST", "NOSE", "LEFT_EAR", "RIGHT_EAR",
                ]:
                    p = lm[getattr(LM, name)]
                    pts[name] = (p.x * w, p.y * h)
                    row[f"{name}_conf"] = round(getattr(p, "visibility", 1.0) or 1.0, 3)
                row["pts"] = pts

                draw_landmarks(frame, lm, w, h)
            frames.append(row)
            writer.write(frame)
            frame_idx += 1

    cap.release()
    writer.release()
    _reencode_for_browser_playback(raw_overlay_out, overlay_out)
    return frames, fps


def compute_metrics(frames):
    """Layer 01: derive knee flexion, hip hinge, torso lean, FPPA per frame — all deterministic."""
    out = []
    for row in frames:
        m = {"frame": row["frame"], "t_ms": row["t_ms"], "visible": row["visible"]}
        if not row["visible"]:
            out.append(m)
            continue
        pts = row["pts"]

        # side-view-friendly metrics (use whichever leg has higher avg confidence)
        left_conf = np.mean([row["LEFT_HIP_conf"], row["LEFT_KNEE_conf"], row["LEFT_ANKLE_conf"]])
        right_conf = np.mean([row["RIGHT_HIP_conf"], row["RIGHT_KNEE_conf"], row["RIGHT_ANKLE_conf"]])
        side = "LEFT" if left_conf >= right_conf else "RIGHT"
        best_conf = max(left_conf, right_conf)
        m["landmark_conf"] = round(float(best_conf), 3)
        if best_conf < 0.6:
            # low-confidence frame (occlusion, motion blur, scene cut) — mark unusable
            # rather than emit a number that looks as trustworthy as a clean frame.
            m["visible"] = False
            out.append(m)
            continue

        hip = pts[f"{side}_HIP"]
        knee = pts[f"{side}_KNEE"]
        ankle = pts[f"{side}_ANKLE"]
        shoulder = pts[f"{side}_SHOULDER"]
        heel = pts[f"{side}_HEEL"]
        toe = pts[f"{side}_FOOT_INDEX"]

        m["side_used"] = side
        m["knee_flexion_deg"] = round(180 - angle_deg(hip, knee, ankle), 1)
        m["hip_y_norm"] = round(hip[1], 1)  # proxy for squat depth (lower y = deeper, image coords)
        m["torso_lean_deg"] = round(angle_deg(shoulder, hip, (hip[0], hip[1] - 100)), 1)

        # shin length as a per-person, per-frame scale reference — lets these
        # pixel-space metrics stay comparable across different camera distances.
        shin_len = max(float(np.hypot(knee[0] - ankle[0], knee[1] - ankle[1])), 1.0)

        # heel rise: on the ground, heel and toe sit at roughly the same height (y).
        # Lifting the heel raises it (smaller y) relative to the planted toe.
        m["heel_rise_norm"] = round((toe[1] - heel[1]) / shin_len, 3)

        # knee-over-toe travel: how far forward (sagittal) the knee has moved past
        # the toe, normalized by shin length. Side-view only — not camera-gated
        # here since, unlike valgus, this is a same-plane (sagittal) measurement
        # that's meaningful from the side, which is exactly where we compute it.
        m["knee_over_toe_norm"] = round((knee[0] - toe[0]) / shin_len, 3)

        # head/neck position: ear offset from the shoulder line, normalized by
        # shin length — a rough proxy for the head dropping or craning forward.
        ear = pts[f"{side}_EAR"]
        m["head_forward_norm"] = round((ear[0] - shoulder[0]) / shin_len, 3)

        # left/right knee-flexion asymmetry — only when BOTH sides are trackable
        # with reasonable confidence (not just the higher-confidence "best" side).
        if left_conf >= 0.6 and right_conf >= 0.6:
            l_flex = 180 - angle_deg(pts["LEFT_HIP"], pts["LEFT_KNEE"], pts["LEFT_ANKLE"])
            r_flex = 180 - angle_deg(pts["RIGHT_HIP"], pts["RIGHT_KNEE"], pts["RIGHT_ANKLE"])
            m["lr_knee_asymmetry_deg"] = round(abs(l_flex - r_flex), 1)

        # stance width — meaningful on a frontal camera; harmless (just not
        # interpretable) on a side view, so computed unconditionally like FPPA.
        ankle_span = float(np.hypot(
            pts["LEFT_ANKLE"][0] - pts["RIGHT_ANKLE"][0],
            pts["LEFT_ANKLE"][1] - pts["RIGHT_ANKLE"][1],
        ))
        shoulder_span = float(np.hypot(
            pts["LEFT_SHOULDER"][0] - pts["RIGHT_SHOULDER"][0],
            pts["LEFT_SHOULDER"][1] - pts["RIGHT_SHOULDER"][1],
        ))
        m["stance_width_norm"] = round(ankle_span / max(shoulder_span, 1.0), 2)

        # frontal-plane metric — only trustworthy on the front-view clip; computed regardless,
        # camera_view field (set by caller) gates whether it's used downstream.
        mag, signed = fppa_deg(pts["LEFT_HIP"], pts["LEFT_KNEE"], pts["LEFT_ANKLE"])
        m["fppa_px"] = round(float(mag), 1)
        m["fppa_signed_px"] = round(float(signed), 1)

        out.append(m)
    return out


def segment_reps(metrics, min_flexion_delta=25.0, min_rep_gap_ms=900, smooth_window=15):
    """Rep/phase segmentation from knee-flexion local minima/maxima (hip-vertical-velocity proxy).
    Deterministic threshold-crossing segmenter — no LLM. Operates only on confidence-gated
    ('visible') frames, and treats a confidence gap as a scene break, not a smoothable dip:
    bridging across it would fabricate motion the pose model never actually saw."""
    reps = []
    rep_id = 0
    in_descent = False
    baseline = None
    bottom_idx = None
    bottom_val = -1
    descent_start_t_ms = None
    last_rep_t_ms = -min_rep_gap_ms

    # split into contiguous visible runs so smoothing never bridges a low-confidence gap
    runs, cur = [], []
    for i, m in enumerate(metrics):
        if m.get("visible"):
            cur.append(i)
        elif cur:
            runs.append(cur)
            cur = []
    if cur:
        runs.append(cur)

    for run in runs:
        if len(run) < smooth_window:
            continue
        flex = np.array([metrics[i]["knee_flexion_deg"] for i in run])
        kernel = np.ones(smooth_window) / smooth_window
        smoothed = np.convolve(flex, kernel, mode="same")
        baseline = float(np.percentile(smoothed, 10))  # robust "standing" estimate for this run
        in_descent = False
        bottom_val = -1
        bottom_idx = None

        for k, idx in enumerate(run):
            v = smoothed[k]
            t_ms = metrics[idx]["t_ms"]
            if v > bottom_val:
                bottom_val = v
                bottom_idx = idx
            if not in_descent and v > baseline + min_flexion_delta:
                in_descent = True
                descent_start_t_ms = t_ms
            elif in_descent and v < baseline + min_flexion_delta / 2:
                bottom_t_ms = metrics[bottom_idx]["t_ms"]
                ascent_end_t_ms = t_ms
                if bottom_t_ms - last_rep_t_ms >= min_rep_gap_ms:
                    rep_id += 1
                    reps.append({
                        "rep_id": rep_id,
                        "bottom_frame": bottom_idx,
                        "bottom_t_ms": bottom_t_ms,
                        "peak_knee_flexion_deg": round(float(bottom_val), 1),
                        "eccentric_ms": bottom_t_ms - descent_start_t_ms if descent_start_t_ms is not None else None,
                        "concentric_ms": ascent_end_t_ms - bottom_t_ms,
                    })
                    last_rep_t_ms = bottom_t_ms
                in_descent = False
                bottom_val = -1
                descent_start_t_ms = None
    return reps


def detect_camera_view(frames, threshold=0.05):
    """Heuristic: frontal cameras show both shoulders clearly separated
    horizontally; side cameras show them nearly overlapping in x. Defaults to
    'side' (the conservative choice — it withholds frontal-plane claims)
    whenever the signal is ambiguous or too few frames are visible."""
    seps = []
    for row in frames:
        if not row.get("visible"):
            continue
        pts = row["pts"]
        l = pts["LEFT_SHOULDER"]
        r = pts["RIGHT_SHOULDER"]
        frame_w = row.get("_frame_w")
        if not frame_w:
            continue
        seps.append(abs(l[0] - r[0]) / frame_w)
    if len(seps) < 10:
        return "side"
    seps.sort()
    median_sep = seps[len(seps) // 2]
    return "frontal" if median_sep >= threshold else "side"


def build_scene_state(metrics, reps, camera_view: str, source: str):
    events = []
    for r in reps:
        idx = r["bottom_frame"]
        m = metrics[idx]
        event = {
            "rep_id": r["rep_id"],
            "type": "rep_bottom",
            "t_ms": r["bottom_t_ms"],
            "knee_flexion_deg": r["peak_knee_flexion_deg"],
            "torso_lean_deg": m.get("torso_lean_deg"),
            "eccentric_ms": r.get("eccentric_ms"),
            "concentric_ms": r.get("concentric_ms"),
            "heel_rise_norm": m.get("heel_rise_norm"),
            "knee_over_toe_norm": m.get("knee_over_toe_norm"),
            "head_forward_norm": m.get("head_forward_norm"),
            "lr_knee_asymmetry_deg": m.get("lr_knee_asymmetry_deg"),
            "camera_view": camera_view,
        }
        if camera_view == "frontal":
            event["fppa_px"] = m.get("fppa_px")
            event["stance_width_norm"] = m.get("stance_width_norm")
            event["frontal_plane_claim_valid"] = True
        else:
            event["frontal_plane_claim_valid"] = False
            event["note"] = (
                "camera is not frontal — valgus/FPPA and stance-width claims withheld per claim "
                "guardrails (both metrics divide by shoulder-to-shoulder distance, which is near-zero "
                "and noisy on a side view since the shoulders nearly overlap in the image)"
            )
        events.append(event)

    return {
        "source_video": source,
        "camera_view": camera_view,
        "n_frames": len(metrics),
        "n_frames_visible": sum(1 for m in metrics if m.get("visible")),
        "n_reps_detected": len(reps),
        "events": events,
    }


def run(video_path: str, camera_view: str | None, out_dir: Path, name: str | None = None):
    """camera_view=None auto-detects from the footage (defaults to 'side',
    the conservative choice, whenever the signal is ambiguous)."""
    name = name or Path(video_path).stem
    overlay_path = str(out_dir / f"{name}_overlay.mp4")
    print(f"[{name}] extracting pose landmarks...", file=sys.stderr)
    frames, fps = extract_landmarks(video_path, overlay_path)
    if camera_view is None:
        camera_view = detect_camera_view(frames)
        print(f"[{name}] auto-detected camera view: {camera_view}", file=sys.stderr)
    print(f"[{name}] {len(frames)} frames @ {fps:.1f}fps, computing metrics...", file=sys.stderr)
    metrics = compute_metrics(frames)
    print(f"[{name}] segmenting reps...", file=sys.stderr)
    reps = segment_reps(metrics)
    scene_state = build_scene_state(metrics, reps, camera_view, video_path)

    (out_dir / f"{name}_metrics.json").write_text(json.dumps(metrics, indent=2))
    (out_dir / f"{name}_scene_state.json").write_text(json.dumps(scene_state, indent=2))
    print(f"[{name}] done. {scene_state['n_reps_detected']} reps detected. "
          f"Overlay: {overlay_path}", file=sys.stderr)
    return metrics, scene_state


def _cli():
    import argparse

    parser = argparse.ArgumentParser(description="Run the capture->kinematics->index pipeline on one video.")
    parser.add_argument("--video", required=True, help="path to the input video file")
    parser.add_argument("--camera-view", choices=["side", "frontal"], default=None,
                         help="omit to auto-detect from the footage")
    parser.add_argument("--out-dir", default=str(Path(__file__).parent / "output"))
    parser.add_argument("--name", default=None, help="output file basename (defaults to the video's stem)")
    args = parser.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    _, scene_state = run(args.video, camera_view=args.camera_view, out_dir=out_dir, name=args.name)
    # Machine-readable result on stdout for callers (e.g. the backend process
    # runner) — everything else in this script logs to stderr for that reason.
    print(json.dumps({
        "scene_state_path": str(out_dir / f"{args.name or Path(args.video).stem}_scene_state.json"),
        "overlay_video_path": str(out_dir / f"{args.name or Path(args.video).stem}_overlay.mp4"),
        "scene_state": scene_state,
    }))


if __name__ == "__main__":
    _cli()
