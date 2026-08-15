import type { VideoStreamKind } from '../transport/types';

/** Minimal track shape ``computeVisionInputStatus`` reads — narrowed to
 *  just the readyState + muted signals so unit tests can pass plain
 *  objects without a real ``MediaStreamTrack``. */
export type VisionTrackLike = { readyState: MediaStreamTrackState; muted: boolean };

export type VisionSourceLike = { kind: VideoStreamKind; track: VisionTrackLike };

/** Pure decision logic behind ``RealtimeClient.getVisionInputStatus``.
 *  Lives in its own module so the per-branch tests can drive it with
 *  synthetic source states (live / paused / ended; screen / camera;
 *  spin-up vs no input) without bringing up a transport.
 *
 *  Browser caveat baked in here: DOM doesn't expose a per-frame callback
 *  on ``MediaStreamTrack``, so unlike the Mac dispatcher we can't track
 *  a rolling last-frame timestamp. ``track.muted`` is the OS-level signal
 *  that frames have stopped (throttled tab, OS-paused capture) and is
 *  treated as the freshness proxy here. */
export function computeVisionInputStatus(
  sources: readonly VisionSourceLike[],
  screenSharePublisher: VisionTrackLike | null,
): { captured: boolean; message: string } {
  const liveSources = sources.filter((s) => s.track.readyState === 'live');
  // Spin-up case: a screen-share track exists in our publisher path but
  // hasn't reached `live` yet. LiveKit takes a moment to negotiate the
  // SDP + start delivering frames.
  if (liveSources.length === 0) {
    if (screenSharePublisher && screenSharePublisher.readyState !== 'live') {
      return {
        captured: false,
        message:
          "The user just started sharing, but the first frame hasn't arrived yet. Ask them to give it a moment and try again.",
      };
    }
    return {
      captured: false,
      message:
        "You don't have fresh visual input right now. Ask the user to start sharing their screen if they want you to see what's on it.",
    };
  }
  const flowing = liveSources.filter((s) => !s.track.muted);
  if (flowing.length === 0) {
    return {
      captured: false,
      message:
        'Visual input is paused (browser tab in background or system-suspended). Ask the user to bring the shared window to the foreground.',
    };
  }
  const kinds = new Set(flowing.map((s) => s.kind));
  if (kinds.has('screen') && kinds.has('camera')) {
    return {
      captured: true,
      message:
        "The user's screen share and camera are both arriving in your vision input right now. Describe what you see from those pixels.",
    };
  }
  if (kinds.has('screen')) {
    return {
      captured: true,
      message:
        'The user is sharing their screen and fresh frames are arriving in your vision input right now. Describe what you see from those pixels.',
    };
  }
  return {
    captured: true,
    message:
      "The user's camera is on and fresh frames are arriving in your vision input right now (this is their camera, not their screen). Describe what you see from those pixels.",
  };
}
