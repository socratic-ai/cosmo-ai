---
name: deadlift
description: Coach the conventional deadlift and RDL — which geometry survives a hinge pattern, what visual verification must carry alone, and the coaching education for each fault.
---

# Deadlift coaching

## The geometry layer — how the numbers exist at all

The pipeline was built around the squat, and a hinge breaks its central
assumption. Read this before quoting any number.

**Rep boundaries are found by knee flexion, and a deadlift barely bends the
knee.** A rep is registered when smoothed knee flexion rises 25° above that
run's standing baseline, then falls back below half of that. A conventional
pull moves the knee maybe 40–70° off lockout, so reps are detected but the
*timing* is wrong: the flexion peak lands near the floor position rather than
at the moment of peak spinal load, and the eccentric/concentric split inherits
that skew. An RDL may never cross 25° at all, in which case the set produces
**zero detected reps** — no error, just an empty event list. Treat a rep count
that disagrees with what the video shows as the segmenter failing, not as the
lifter miscounting. Hip travel is the real rep signal here, and nothing in the
pipeline segments on it.

**What happens when a frame is wrong.** Each frame is gated on the average
confidence of the better leg's hip–knee–ankle. Below 0.6 the frame is dropped
entirely and splits the recording into separate runs; smoothing never bridges
a gap. The baseline is re-estimated per run, so a set interrupted by a
low-confidence stretch gets two different "standing" references — on a lift
where the standing position *is* the lockout, that shifts what counts as a rep.

**Camera gating.** Frontal-plane numbers (FPPA, stance width) divide by
shoulder-to-shoulder distance and are withheld unless the camera reads as
frontal. Deadlifts are almost always filmed from the side, so assume those
numbers will be absent, and don't reach for them.

## Top issues — geometry, visual verification, education

### 1. Lumbar rounding under load

**Geometry tells you: nothing.** There is no spine landmark; the torso is one
rigid shoulder-to-hip segment by construction. `torso_lean_deg` reads the same
for a flat back at 30° and a rounded back at 30°. This is the highest-stakes
fault on the lift and geometry is silent on it.
**Visual verification tells you: everything.** Eyes are the only evidence.
The visual pass must also state whether the back was actually visible — a
loose shirt, a bar path crossing the torso, or a camera behind the lifter all
mean "couldn't see," which is the correct finding, not a pass.
**Education:** the priority fault. Cue a braced neutral spine before the bar
leaves the floor ("chest tall, take the slack out"), and cut load until the
shape holds. Always phrase it as "it looks like" — observed, not measured.

### 2. Hips rising before the shoulders

**Geometry tells you: nothing today — but this one is genuinely reachable.**
Hip and shoulder points are both tracked, so comparing their vertical
velocities off the floor is ordinary arithmetic. It is simply not computed:
`compute_metrics` emits no shoulder height, and `hip_y_norm` — despite the
name — is the raw image y of the hip in pixels, normalized by nothing, so it
is not comparable across camera distances or between clips. The raw landmark
points aren't written to disk either; only the derived metrics are. So this is
visual-only *until the pipeline gains a hip-vs-shoulder vertical-velocity
metric*, and adding it means changing the pipeline, not just the prompt.
**Visual verification tells you: whether it happened, per rep.** The hips
shooting up while the bar stays on the floor is one of the most visually
obvious faults there is from the side.
**Education:** it converts the pull into a stiff-legged good morning at the
worst moment. Cue "push the floor away, chest and hips rise together." Usually
either a setup-height problem or quads that give up early.

### 3. Starting torso angle and the shape of the lift

**Geometry tells you: `torso_lean_deg`, and it is trustworthy here.** The
angle between the shoulder-to-hip segment and vertical is a clean measurement
that does not depend on camera gating. A conventional pull starts steeply
inclined and finishes vertical; the number tracks that arc well. The trap is
the same one as in the squat: build changes the normal range legitimately, and
this number cannot distinguish a hinge shape from a rounded one — issue 1 and
this one share a measurement and are different faults.
**Visual verification tells you: which fault it is.** Given a steep torso,
eyes decide whether the back is flat (fine, that's a deadlift) or curving
under load (issue 1). That adjudication changes the entire recommendation.
**Education:** don't coach a torso angle toward some ideal number. Coach the
setup that produces it — bar over midfoot, shoulders slightly ahead of the
bar, hips wherever the lifter's proportions put them.

### 4. Balance and heel pressure

**Geometry tells you: `heel_rise_norm`, with the squat's caveats intact.**
`(toe_y − heel_y) / shin_length`, flat ≈ 0, above ~0.1 is a real rise. Heel
and toe are the smallest and most-occluded landmarks, and the confidence gate
checks hip–knee–ankle — never the foot — so a frame can pass the gate with
junk foot points. Read the trend across a rep, never a single frame. Loaded
plates sitting in front of the foot make this worse on a deadlift than on a
squat.
**Visual verification tells you: whether to trust the number.** Eyes confirm
the heel genuinely leaving the floor and veto the occluded cases where the
number is noise.
**Education:** on a pull, weight shifting to the toes usually means the bar
started ahead of midfoot. Fix the setup before cueing the feet.

### 5. Bar drifting away from the body

**Geometry tells you: nothing, and it cannot.** The pipeline tracks body
landmarks only — there is no bar landmark, no barbell detection, nothing that
knows an implement exists. Bar path is unmeasured and will stay unmeasured
until an object detector is added.
**Visual verification tells you: everything.** The bar swinging out in front
of the shins, or drifting forward at the knee, is clearly visible from the
side and is exactly what the visual pass is for.
**Education:** a bar away from the body is a longer lever on the lower back.
Cue "drag it up your legs, lats tight, shins close." Report it as an
observation, never with a distance.

### 6. Lockout: hitching and hyperextension

**Geometry tells you: almost nothing.** Lockout is where knee flexion returns
to baseline, so the segmenter treats it as an endpoint rather than something
to describe. A hitch — the bar ratcheting up in stages — is a velocity pattern
in a signal the pipeline doesn't compute, and leaning back past vertical at
the top would push `torso_lean_deg` slightly negative-ish in principle, but
the metric is an unsigned angle to vertical, so overextension and a small
forward lean are indistinguishable.
**Visual verification tells you: whether it happened.** Both faults are
obvious to eyes and invisible to the numbers.
**Education:** hitching means the weight is too heavy for the current pattern.
Leaning back at lockout adds nothing and loads the lumbar spine in extension —
cue "stand tall, squeeze the glutes, stop there."

## How to coach the conversation

- Lead with rep-count honesty. If the segmenter found a number of reps that
  doesn't match the video — very likely on RDLs — say so before discussing any
  per-rep finding.
- At most two or three corrections, spine safety first.
- Anchor to a specific rep and play the moment rather than describing it.
- Praise something genuinely measured — torso angle, heel contact — before the
  first correction.
- Provenance discipline: measured things get numbers; visual things get "it
  looks like"; anything from a rep the visual pass disputed gets nothing.
