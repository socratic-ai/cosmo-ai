import { describe, expect, it } from 'vitest';

import {
  computeVisionInputStatus,
  type VisionSourceLike,
  type VisionTrackLike,
} from './vision_input_status';

const liveTrack: VisionTrackLike = { readyState: 'live', muted: false };
const mutedTrack: VisionTrackLike = { readyState: 'live', muted: true };
const endedTrack: VisionTrackLike = { readyState: 'ended', muted: false };

const screenLive: VisionSourceLike = { kind: 'screen', track: liveTrack };
const cameraLive: VisionSourceLike = { kind: 'camera', track: liveTrack };
const screenMuted: VisionSourceLike = { kind: 'screen', track: mutedTrack };
const cameraMuted: VisionSourceLike = { kind: 'camera', track: mutedTrack };
const screenEnded: VisionSourceLike = { kind: 'screen', track: endedTrack };

/**
 * Locks in the per-branch wording the dispatcher's ``get_current_screen``
 * forwards to the model. These are the regression cases that motivated
 * the rework — the old static ``readyState === 'live'`` check missed the
 * camera source, the screen-share spin-up gap, and the throttled-tab
 * paused-track signal. Any future change to the decision logic must keep
 * the model-facing distinction between these states.
 */
describe('computeVisionInputStatus', () => {
  it('reports no input when no sources and no spin-up publisher', () => {
    const status = computeVisionInputStatus([], null);
    expect(status.captured).toBe(false);
    expect(status.message).toMatch(/don't have fresh visual input/);
  });

  it('reports spin-up when the screen-share publisher exists but is not live', () => {
    const publisher: VisionTrackLike = { readyState: 'ended', muted: false };
    const status = computeVisionInputStatus([], publisher);
    expect(status.captured).toBe(false);
    expect(status.message).toMatch(/first frame hasn't arrived/);
  });

  it('reports captured for a live screen-share source', () => {
    const status = computeVisionInputStatus([screenLive], liveTrack);
    expect(status.captured).toBe(true);
    expect(status.message).toMatch(/sharing their screen/);
  });

  it('reports captured for a live camera source, naming the camera', () => {
    const status = computeVisionInputStatus([cameraLive], null);
    expect(status.captured).toBe(true);
    expect(status.message).toMatch(/camera is on/);
    expect(status.message).toMatch(/not their screen/);
  });

  it('reports both sources when screen and camera are simultaneously live', () => {
    const status = computeVisionInputStatus([screenLive, cameraLive], liveTrack);
    expect(status.captured).toBe(true);
    expect(status.message).toMatch(/screen share and camera are both/);
  });

  it('reports paused when every live source is muted', () => {
    const status = computeVisionInputStatus([screenMuted, cameraMuted], mutedTrack);
    expect(status.captured).toBe(false);
    expect(status.message).toMatch(/Visual input is paused/);
  });

  it('ignores ended tracks when picking a fresh source', () => {
    const status = computeVisionInputStatus([screenEnded], null);
    expect(status.captured).toBe(false);
    expect(status.message).toMatch(/don't have fresh visual input/);
  });

  it('counts a live camera even when a screen-share publisher is still spinning up', () => {
    const publisher: VisionTrackLike = { readyState: 'ended', muted: false };
    const status = computeVisionInputStatus([cameraLive], publisher);
    // A live camera frame is real vision input — it wins over the
    // publisher's spin-up message which would otherwise tell the model
    // "no frames yet".
    expect(status.captured).toBe(true);
    expect(status.message).toMatch(/camera is on/);
  });

  it('still reports the screen-only wording when a muted camera sits alongside a live screen', () => {
    const status = computeVisionInputStatus([screenLive, cameraMuted], liveTrack);
    expect(status.captured).toBe(true);
    expect(status.message).toMatch(/sharing their screen/);
    expect(status.message).not.toMatch(/camera/);
  });
});
