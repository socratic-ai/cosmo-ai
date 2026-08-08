---
name: lunge
description: Coach the forward/reverse/walking lunge — which geometry survives alternating legs, why the leg a number came from is ambiguous, and what visual verification must carry.
---

# Lunge coaching

## The geometry layer — how the numbers exist at all

More of the squat's machinery survives here than on any other variation — a
lunge is a knee-flexion cycle, which is exactly what the pipeline segments on.
The problem is not whether there's a number. It's knowing **which leg** the
number describes.

**Rep boundaries mostly work.** Knee flexion rises 25° above that run's
standing baseline and falls back below half of it; the flexion peak between
those crossings is the bottom, and a 900ms refractory gap stops double counts.
Both the front and the back knee bend deeply in a lunge, so crossings fire
reliably. Walking lunges are the weak case: the lifter never returns to a
clean standing baseline between reps, so the 10th-percentile "standing"
estimate sits higher than it should and shallow reps can be missed.

**Which leg is measured changes silently, and the consumer can't see it.**
Each frame picks whichever leg has the higher hip–knee–ankle confidence and
records that choice as `side_used`. From a side view that's the near leg — and
in an alternating set the near leg is the *front* leg on some reps and the
*back* leg on the next. So `knee_flexion_deg` describes front-knee depth on
one rep and back-knee bend on the next, with nothing in the output marking the
switch: `side_used` lives in the per-frame metrics and is **not** carried into
the rep events the coach actually reads. Before comparing depth across reps,
confirm from the video that the same leg was in front; if the set alternates,
compare reps in pairs rather than as one series.

**The confidence gate and gaps.** Frames below 0.6 leg confidence are dropped
and split the recording into runs; the baseline is re-estimated per run and
smoothing never bridges a gap. A lunge crosses the frame more than a squat
does, so gaps are more common — especially on walking lunges.

**Camera gating.** Frontal-plane numbers are withheld unless the camera reads
frontal, and side-view numbers only mean something from the side. A lunge
genuinely needs both views for a full read; say which one you have.

## Top issues — geometry, visual verification, education

### 1. Front-knee valgus (knee caving inward)

**Geometry tells you: a real number, front view only — and only for the left
leg.** FPPA measures the knee's sideways deviation off the hip-to-ankle line,
and it is the most trustworthy fault signal in the set from the front. But the
pipeline computes it from the **left** hip, knee and ankle unconditionally,
regardless of which leg is forward. On a left-lead rep it is the front-knee
valgus number; on a right-lead rep it is describing the trailing leg, where
it means very little. Read it only on reps you've confirmed are left-lead, and
say plainly that right-lead valgus is not measured by the current pipeline.
From a side view it's withheld entirely.
**Visual verification tells you: the other leg, and the side-view fallback.**
Eyes cover right-lead reps and can sometimes catch a knee dipping in from an
angled view — report that low-confidence.
**Education:** cue "front knee tracks over the middle toe." A lunge is a
narrow, unstable base, so cave here is usually hip stability rather than
strength; note whether it shows up only on late reps.

### 2. Left/right imbalance between lead legs

**Geometry tells you: `lr_knee_asymmetry_deg`, read differently than on a
squat.** It's the absolute difference in flexion between the two legs, emitted
only when **both** legs clear 0.6 confidence. On a squat any large value is a
red flag; on a lunge the legs are asymmetric by design, so a big number is
just the exercise. What's meaningful is comparing this value at the bottom of
left-lead reps against right-lead reps — a consistent difference between the
two sides is a real imbalance. The catch: from a side view the far leg is
occluded, so the metric is legitimately absent on many frames; a front view
gives you both legs but costs the sagittal numbers.
**Visual verification tells you: whether the sides looked different.** A lifter
who drops fast on one side and grinds on the other is visible even when the
number is missing, and it identifies which reps were which lead.
**Education:** a side difference is normal and small; a large or growing one
is worth a few weeks of extra single-leg work on the weaker side. Don't
alarm anyone over one set.

### 3. Torso wobble and balance

**Geometry tells you: very little.** `torso_lean_deg` measures inclination
against vertical in the image plane, so a forward lean registers — but the
wobble that matters in a lunge is *lateral* sway and rotation, which a
single 2D inclination angle can't separate from a forward hinge, and which the
pipeline does not measure at all. There is no side-to-side balance metric and
no center-of-mass estimate.
**Visual verification tells you: whether they were steady.** Hunting for
balance, a foot repositioning mid-rep, or an arm shooting out is obvious to
eyes and completely invisible to the numbers.
**Education:** instability usually means stride placement, not weakness. Cue a
slightly wider track — feet on two rails, not a tightrope — and slow the
descent down before adding load.

### 4. Back-knee slam and descent control

**Geometry tells you: nothing about the contact.** The floor isn't modeled;
there is no ground plane, no contact detection, and no vertical-velocity
metric. `eccentric_ms` gives descent duration for the detected rep, which is a
weak proxy at best — and it describes whichever leg the segmenter happened to
follow.
**Visual verification tells you: whether the knee hit the floor hard.** Very
visible, and often audible in the source video.
**Education:** the back knee should kiss the floor, not bang it. Cue "control
the last two inches" and shorten the range slightly rather than adding a pad.

### 5. Stride length and front-knee travel

**Geometry tells you: two numbers, both with traps.** `knee_over_toe_norm` is
forward knee travel past the toe in shin-lengths, side view only; its sign
assumes a facing direction, so read magnitude unless facing is known — and on
walking lunges the lifter may turn mid-set, flipping it. `stance_width_norm`
is ankle separation over shoulder separation, which was designed for a
side-by-side stance. In a split stance the feet are separated front-to-back,
so from the front the ankles nearly overlap in the image and the number comes
out misleadingly small. Don't quote stance width on a lunge.
**Visual verification tells you: whether the stride suited the lifter.** Too
short crowds the front knee forward; too long strands the back leg and stops
the hips from dropping. This is a judgment call eyes make well and no number
here captures.
**Education:** never coach "knee behind the toe" as a rule. Aim for a shin
close to vertical at the bottom with both knees near 90°, and adjust stride
until that happens.

## How to coach the conversation

- Establish which leg is which first. If you can't tell from the video which
  reps were left-lead, say so and keep the feedback general rather than
  attaching numbers to the wrong side.
- Two or three corrections at most; knee tracking and balance before stride.
- Anchor to a specific rep and play the moment.
- Praise something genuinely measured — depth, tempo consistency — before the
  first correction.
- Provenance discipline: measured things get numbers; visual things get "it
  looks like"; a disputed rep, or a number whose leg you can't confirm, gets
  nothing at all.
