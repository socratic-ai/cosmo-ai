# squat-coach

Upload a video of a squat set, then talk to a voice coach about it. The coach
can replay the exact moment it's describing.

Demonstrates using `cosmo-ai` for a session grounded in analysis that
happened *before* the call — the model isn't watching video during the
conversation, it's reasoning over a prepared index and pulling clips on demand.

## The idea

Streaming a whole video into a realtime model is slow to first useful word and
gives poor temporal grounding. Instead this precomputes structure, hands the
realtime model a small index, and gives it a tool to fetch pixels when it wants
to show you something.

Three stages:

**1. Measure (deterministic).** MediaPipe pose → joint angles → rep
segmentation, in plain Python. No model involved, so the numbers are
reproducible: knee flexion, torso lean, tempo, heel rise, knee travel,
left/right asymmetry.

This stage can't see spine curvature — sparse-landmark pose models have no
spine landmark, so the torso is one rigid shoulder-to-hip segment. That's a
property of the representation, not a tuning problem.

**2. Review (Gemini Flash, two passes).** Two passes because auditing and
synthesizing need opposite information:

- *Audit* sees raw footage and bare rep timestamps — no measurements. The
  blindness is deliberate: it's what lets this pass disagree with stage 1.
  In testing it flagged that two detected "reps" were actually the unrack
  phase, which stage 1 had scored as real reps with confident-looking numbers.
- *Synthesis* sees everything — measurements, the audit's findings, the overlay
  video — and writes the final answer, excluding disputed reps and marking each
  finding as `measured`, `visual`, or `both`.

**3. Coach (realtime session).** Gets the synthesized findings as instructions
and a `play_video` client tool. Ask "show me the worst rep" and it seeks the
player to that moment.

Optional — the demo runs without a `GEMINI_API_KEY`, just with stage 2 skipped.

## Setup

Prerequisites: Node 18+, Python 3.11, and `ffmpeg` on PATH. (OpenCV writes
MPEG-4 Part 2, which browsers can't decode, so overlays get re-encoded to
H.264 — without ffmpeg the video won't play.)

```bash
# 1. This example (cosmo-ai is the published npm package)
cd examples/typescript/squat-coach
npm install

# 2. Python pipeline
python3.11 -m venv pipeline/venv
pipeline/venv/bin/pip install -r pipeline/requirements.txt

curl -sL -o pipeline/models/pose_landmarker_lite.task --create-dirs \
  https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task

# 3. Keys — see the comments in .env.example for where to get each
cp .env.example .env
```

You need a Cosmo API key to start a voice session (paste it into the form, or
put it in `.env`). `GEMINI_API_KEY` is optional but does most of the
interesting work; without it stage 2 is skipped and the UI says so.

## Run

Two processes:

```bash
npm run server   # pipeline backend on :7861
npm run dev      # UI on :7860
```

Open http://localhost:7860, drop in a video, wait for processing, then start
the session and allow microphone access.

Processing a 67s clip takes about a minute: ~22s of pose extraction, then ~40s
across the two Gemini calls. Gemini is the larger share, and it varies run to
run. Running several clips at once makes each one slower — they compete for the
same cores.

The progress stages are an estimate, not a measurement — a single request with
no progress events to report — so it shows elapsed time rather than pretending
to know how far along it is.

**Your API key and the server have to come from the same environment.** A key
minted against one backend won't authenticate against another — you get a 401,
the session never connects, and there's no audio. If you point the server field
at a non-production backend, use a key from that backend.

No sample clips ship with this example — record your own set. Footage that
works well:

- **Continuous single-take footage of one person**, full body in frame, from
  a steady camera.
- **Side view** for depth, tempo, torso lean. **Front view** additionally
  unlocks knee-tracking and stance width — those are withheld from the side
  because both divide by shoulder span, which is near-zero and noisy when the
  shoulders overlap in the image.

Avoid clips with scene cuts, or tutorial footage that cuts away to someone
explaining with a prop. Rep segmentation follows knee angle and can't tell
that the scene changed. Stage 2 usually catches it and marks those reps
disputed — that's what `reps_disputed` is for — but it's better to avoid.

## Files

The following table lists the files that make up the example.

| | |
|---|---|
| `src/App.tsx` | UI, `play_video` client tool, session setup |
| `server/index.js` | upload → runs the pipeline → returns index + findings |
| `pipeline/pipeline.py` | stage 1: pose → angles → reps |
| `pipeline/layer2_twopass.py` | stage 2: audit pass, then synthesis pass |
| `pipeline/layer2_narrator.py` | single-pass variant, and the shared schema |
| `pipeline/build_1fps_summary.py` | 1fps captioned summary video (see below) |

`build_1fps_summary.py` isn't on the default path. Gemini samples video at
roughly 1fps regardless of what you send, so this script makes that choice
explicit: one representative frame per second, captioned with what full-rate
analysis found across that whole second. It's included as an alternative
stage-2 input to experiment with — it trades better spine-curvature detection
for weaker rep-segmentation auditing.

## If something goes wrong

**Upload returns 404.** The Vite dev server proxies `/api` to the backend on
:7861. Editing `vite.config.ts` restarts Vite, and if it restarts while the
config is mid-write it can come back without the proxy. Restart `npm run dev`.
Check the backend directly to confirm it's fine: `curl -X POST -F
"video=@clip.mp4" http://localhost:7861/api/process-video`.

**Session says "Not connected" and there's no audio.** Almost always the key
and server are from different environments — see above. The browser console
shows the 401.

**Nothing happens after processing.** `GEMINI_API_KEY` unset only skips the
visual passes; the coach still works from measurements. The UI says so when
that's the case.

## Before you copy this into something real

The backend here is deliberately minimal, and a few things are fine for a local
demo but wrong for anything users touch:

- **Processed videos are served openly.** Uploads and overlays land in
  `.generated/` and are served at `/generated/<job>_raw.mp4` with no auth,
  expiry, or cleanup. Anyone who can reach the server and guess a job id can
  fetch someone's video. Real deployments want private storage, signed
  expiring URLs, and deletion.
- **Uploads are barely validated.** There's a size cap and a content-type
  check, but the bytes still reach OpenCV, MediaPipe and ffmpeg. Probe with
  `ffprobe` and bound duration and resolution before trusting a file.
- **One job at a time, enforced crudely.** A second upload gets a 429. That's
  a stand-in for a real queue.
- **Model output is schema-constrained but not re-validated** after it comes
  back, and it becomes both UI copy and realtime instructions.

## Known limitations

- **Front-view clips**: `knee_over_toe_norm` and `head_forward_norm` measure
  horizontal offsets, which only mean something from the side. They aren't
  camera-gated the way the valgus metrics are, so treat them as unreliable on
  front-facing footage.
- **Spine**: no pose model here has a spine landmark — the torso is one rigid
  shoulder-to-hip segment. Anything about back rounding comes from the visual
  pass, not measurement, which is why provenance is marked.
- **Rep segmentation** follows knee angle and can't tell an unrack from a rep.
  The audit pass usually catches it and marks those reps disputed.

## Notes

- The realtime model never sees video. It reasons over the index and calls
  `play_video` to show you things.
- Findings carry provenance. `visual` means it was seen but not measured, and
  should be spoken as an observation, not a number.
- Frontal-plane claims (knee valgus, stance width) are withheld unless the
  camera is roughly front-on — both divide by shoulder span, which is near-zero
  and noisy from the side.
