---
name: pushup
description: Coach the push-up — why the pipeline's geometry mostly does not apply, which numbers are computable but uncomputed, and what visual verification has to carry alone.
---

# Push-up coaching

## The geometry layer — how the numbers exist at all

Be blunt with the lifter about this one: the measurement layer was built for a
squat and a push-up falls almost entirely outside it. Most of what follows is
about what is *missing*.

**The primary signal — elbow angle — is not computed, and the landmark isn't
even collected.** A push-up rep is an elbow flexion cycle. The pipeline
extracts a fixed list of seventeen named landmarks (hips, knees, ankles,
shoulders, heels, toes, wrists, nose, ears) and **elbow is not on that list**.
So elbow angle isn't one formula away — it needs the landmark added to
extraction *and* the angle computed. Say "elbow angle isn't measured by the
current pipeline" rather than implying a number is being withheld.

**Rep segmentation therefore does not work.** Reps are found by knee flexion
crossing 25° above a standing baseline. In a good push-up the knees stay
locked straight for the entire set, so knee flexion never moves and **no reps
are detected at all** — the output is an empty event list, not an error. If a
rep count does appear, it came from the knees bending, which on a push-up is
itself the fault (see issue 2), or from the lifter setting up and standing
back up. Never present a detected rep count on a push-up as a rep count.

**The confidence gate watches the wrong limb.** A frame is kept only if the
better leg's hip–knee–ankle confidence averages at least 0.6. On a push-up the
legs are the least interesting and most reliably tracked part of the body, so
the gate will happily pass frames where the arms and shoulders — the part that
matters — are occluded or blurred.

**Camera gating.** FPPA and stance width divide by shoulder-to-shoulder
distance and are withheld unless the camera reads frontal. Neither means
anything on a push-up regardless; don't reach for them.

## Top issues — geometry, visual verification, education

### 1. Depth — how far the chest actually descends

**Geometry tells you: nothing today.** This is elbow angle, covered above:
landmark not collected, angle not computed. There is also no chest landmark,
so "chest to the floor" has no direct proxy either.
**Visual verification tells you: everything, and it is well suited to it.**
Descent depth from a side view is one of the easiest things for eyes to judge,
including the half-rep pattern that creeps in late in a set.
**Education:** partial reps are usually fatigue or too-hard a variation, not
laziness. Regress to an incline and keep full range rather than grinding out
short reps. Phrase as "it looks like" throughout — there is no number here.

### 2. Body-line sag or pike (hips dropping or riding high)

**Geometry tells you: nothing today — but this is the most reachable gap in
the whole skill.** The measurement is the hip's perpendicular distance from
the shoulder-to-ankle line, and the pipeline already contains exactly that
math: `fppa_deg()` projects a middle point onto the line through the outer two
and returns the deviation. It is currently only ever called with hip/knee/ankle
for the squat's valgus. Feeding it shoulder/hip/ankle, normalized by a limb
length the way the other metrics normalize by shin length, would give a real
sag number. Until that call exists, this is visual-only.
**Visual verification tells you: whether it happened, and when in the set.**
Hips sagging is highly visible from the side and typically appears in the last
few reps as the brace fails.
**Education:** the plank is the exercise; the arms just move it. Cue "squeeze
the glutes, ribs down, one straight line from ear to heel." Sagging under
fatigue means stopping the set, not pushing through.

### 3. Head droop or forward crane

**Geometry tells you: nothing usable, and the existing metric would mislead
you.** `head_forward_norm` is `(ear_x − shoulder_x) / shin_length` — a purely
horizontal offset, which works on a standing squat because the body axis is
vertical. In a push-up the body axis is horizontal, so an ear-vs-shoulder
*x*-offset runs along the body rather than across it: a dropped head barely
moves it, and a perfectly neutral head can produce a large value. The approach
transfers, the metric does not. Do not quote `head_forward_norm` on a push-up
even though it will be present in the output.
**Visual verification tells you: whether the head leads the chest down.**
Clearly visible from the side, and often the first thing to go.
**Education:** the head dropping to touch the floor fakes depth. Cue "eyes at
a spot a foot in front of your hands, head stays in line with the spine."

### 4. Hand position and elbow flare

**Geometry tells you: nothing reliable.** Wrists are tracked, so a
wrist-under-shoulder check is in principle computable — but the useful version
needs a top-down or front view, and elbow flare needs the uncollected elbow
landmark plus a viewing angle that resolves it. Neither is available.
**Visual verification tells you: as much as the camera allows.** From a side
view, hand placement relative to the shoulder is judgeable and flare largely
is not; a front or angled view reverses that. The visual pass should say which
view it had before claiming either.
**Education:** hands roughly under the shoulders, elbows back at maybe 45°
rather than flared straight out to the sides. Flare is a shoulder-comfort
issue more than a strength one, so coach it gently.

### 5. Scapular control

**Geometry tells you: nothing, ever.** Shoulder blade position needs landmarks
on the scapula, which no sparse pose model has — the shoulder is one point.
This is a representation limit, not a tuning gap, the same argument as spine
curvature on the squat.
**Visual verification tells you: something, from the right angle.** Winging or
a shoulder collapsing forward at the bottom is visible from behind or above,
and largely invisible from a straight side view. Report low-confidence if the
angle is wrong, or don't report it.
**Education:** cue "push the floor away at the top" to get protraction, and
control the blades on the way down rather than letting the chest collapse
between them.

## How to coach the conversation

- Open with the honest framing: the numbers on screen are squat metrics and
  most of them don't apply here, so this session is mostly what the video
  shows. Say it once, plainly, then move on — don't hedge every sentence.
- Never quote a rep count, elbow angle, or `head_forward_norm` for a push-up.
- Two or three corrections at most; body line before depth, depth before
  hand position.
- Anchor to a moment in the video and play it rather than describing at length.
- Praise something specific and genuinely observed before the first correction.
- Provenance discipline: visual things get "it looks like." On this exercise
  that is nearly everything, and saying so builds trust rather than losing it.
