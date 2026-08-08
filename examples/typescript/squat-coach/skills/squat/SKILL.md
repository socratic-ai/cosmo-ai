---
name: squat
description: Coach the back/bodyweight squat — per-fault geometry (formula, reliability, failure behavior), what visual verification adds, and the coaching education.
---

# Squat coaching

## The geometry layer — how the numbers exist at all

Pose tracking gives 33 landmarks per frame; every metric is plain trigonometry
on them. Know three things about every number before repeating it:

**How rep boundaries are found.** Knee flexion is computed per frame
(`180° − angle(hip, knee, ankle)`), smoothed over a 15-frame window, and a rep
is a threshold crossing: flexion rises 25° above the standing baseline
(descent), then falls back below half that (ascent complete). The bottom is
the flexion peak between those crossings. A 900ms refractory gap stops one
wobble from counting twice. This segmenter knows nothing about squats — it
follows knee angle. Unracking, walking out, or a scene cut can produce
crossings that get scored as "reps" with confident-looking numbers.

**What happens when a frame is wrong.** Every frame carries per-landmark
confidence. If the best leg's average confidence is under 0.6 the frame is
marked unusable and excluded — it contributes nothing rather than a wrong
number. Consecutive unusable frames split the recording into separate runs and
smoothing never bridges a gap (bridging would fabricate motion the tracker
never saw). Cost of this honesty: a rep whose bottom falls in a gap is simply
missed, and metrics near gap edges come from fewer frames.

**Camera gating.** Frontal-plane numbers (valgus/FPPA, stance width) divide by
shoulder-to-shoulder distance, which is near zero from the side — withheld
unless the camera is frontal. Sagittal numbers (knee-over-toe, head-forward)
are horizontal offsets that only mean something from the side.

## Top issues — geometry, visual verification, education

### 1. Spine rounding under load

**Geometry tells you: nothing.** No spine landmark exists; the torso is one
rigid shoulder-to-hip segment by construction. `torso_lean_deg` cannot
distinguish a proud chest at 45° from a rounded back at 45°.
**Visual verification tells you: everything.** This fault is visual-only
evidence, and it is the main reason the visual pass exists. It must also
report whether the back was actually visible (arm occlusion, camera angle,
baggy clothing) — a missing finding on an occluded back is correct, not a
pass.
**Education:** highest-priority fault — it loads a flexed spine. Cue a hard
brace ("big breath, ribs down"), reduce load until the shape holds. Say "it
looks like" — it was observed, not measured.

### 2. Butt wink (pelvis tucking under at the bottom)

**Geometry tells you: almost nothing directly.** The pelvis is a single point,
not an orientation — a tuck changes no measured angle. What geometry does
contribute: the exact timestamp of each rep's bottom (where wink happens), and
the depth at which it appears — wink only past 110° flexion is a
depth-management fix, not a bracing fix.
**Visual verification tells you: whether it happened, per rep.** The pelvis
visibly rotating under is a shape change eyes catch easily from the side.
Severity (mild/moderate/severe) is a judgment call the visual pass owns.
**Education:** mild wink is common and often benign unloaded; under load it
matters. Cue: squat to just above the depth where the tuck starts, brace, and
earn the extra depth over weeks.

### 3. Heel rise / weight on toes

**Geometry tells you: a direct, decent number.** `heel_rise_norm =
(toe_y − heel_y) / shin_length` — flat foot ≈ 0; above ~0.1 is a real rise.
Reliability caveats: heel and toe are the smallest, most-occluded landmarks,
and the frame gate checks hip–knee–ankle confidence, not foot confidence — a
frame can pass while its foot points are junk. Trust the trend across a rep,
not one frame.
**Visual verification tells you: whether to trust the number.** Eyes confirm
the heel actually leaving the floor and catch the occlusion cases (plates,
grass, shadow) where the number is noise. Agreement between the two upgrades
the finding to `both`; a visual veto on an occluded foot kills it.
**Education:** weight on toes = knees take over, balance degrades. Cue "whole
foot — big toe, little toe, heel"; persistent cases are usually ankle mobility
(heels-elevated squats as the regression).

### 4. Knee cave / valgus

**Geometry tells you: a real number, front view only.** FPPA — the knee's
sideways deviation off the hip-to-ankle line. Inward = valgus. From the front
this is the most trustworthy fault signal in the set; from the side it is
withheld entirely.
**Visual verification tells you: the side-view fallback, weakly.** From the
side, eyes can sometimes catch a knee dipping inward that geometry must stay
silent about — report it low-confidence. From the front, visual mostly
confirms what FPPA already measured.
**Education:** cue "knees track over toes"; check stance width (~1.0–1.5
shoulder-widths typical); note whether cave appears only on late reps
(fatigue) or every rep (pattern/strength).

### 5. Excessive forward lean

**Geometry tells you: `torso_lean_deg`, with an interpretation trap.** Reliable
as an inclination; but build and style move the normal range (low-bar, long
femurs lean more, legitimately). Sustained 50°+ with hips shooting back is the
pattern worth naming. It cannot see rounding — issue 1 and this one share a
number but are different faults.
**Visual verification tells you: which fault it is.** Given a big lean, eyes
decide: straight back hinging hard (style/mobility) or spine curving under
load (safety). That adjudication is the whole difference in the advice given.
**Education:** cue "chest up, hips under you"; lean plus heel-pressure loss
points at the ankle-mobility chain, not a cueing problem.

### 6. Knee-over-toe travel

**Geometry tells you: `knee_over_toe_norm`, side view only** — forward knee
travel past the toe in shin-lengths. Caveat: the sign assumes facing
direction; footage facing the other way flips it — read magnitude unless
facing is known.
**Visual verification tells you: context.** Whether the travel comes with a
stable flat foot (fine, deep squats need travel) or with heels peeling and
weight lurching forward (the actual problem).
**Education:** never coach "never past the toes" — travel is required for
depth. It matters only combined with heel rise.

### 7. Asymmetry, depth consistency, tempo

**Geometry tells you:** `lr_knee_asymmetry_deg` needs both legs above 0.6
confidence — from a side view the far leg is occluded, so it's legitimately
missing on many frames; over ~8° when present is meaningful. Depth and tempo
come from the segmenter and inherit its failure modes.
**Visual verification tells you: whether the reps were real.** Its single most
valuable catch is segmentation: a "rep" that was actually the unrack, a walk,
a cut. A disputed rep's depth/tempo numbers are measurements of something that
wasn't a squat — never quote them.
**Education:** name the lifter's own best rep as the target ("rep 6 was your
standard — match it"). Tempo collapse late in a set is a fatigue note, rarely
the headline.

## How to coach the conversation

- At most two or three corrections; safety-relevant first.
- Anchor to specific reps and show the moment (`play_video`) rather than
  describing at length.
- Praise something genuinely good — from the measurements — before the first
  correction.
- Provenance discipline: measured things get numbers; visual things get "it
  looks like"; a claim from a disputed rep gets nothing at all.
