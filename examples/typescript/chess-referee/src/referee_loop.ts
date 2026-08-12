import type { BoardOrientation, BoardVisionConfig } from './board_vision';
import { readBoardPosition } from './board_vision';
import type { FrameCapture } from './frame_capture';
import type { Referee, RefereeEvent } from './referee';

export type RefereeLoopOptions = {
  capture: FrameCapture;
  vision: BoardVisionConfig;
  referee: Referee;
  /** Pin the board orientation instead of letting the endpoint detect it.
   *  The starting position is legal from both sides, so detection can lock
   *  the wrong way on move one — pinning is the reliable path. */
  orientation?: BoardOrientation;
  onEvent: (event: RefereeEvent) => void;
  onReadError?: (error: unknown) => void;
  intervalMs?: number;
};

/** Continuously read the board through the vision endpoint and feed the
 *  referee. One read in flight at a time; the next starts `intervalMs` after
 *  the previous settles, so a slow endpoint stretches the cadence instead of
 *  stacking requests. Returns a stop function. */
export function startRefereeLoop(options: RefereeLoopOptions): () => void {
  const { capture, vision, referee, onEvent, onReadError } = options;
  const intervalMs = options.intervalMs ?? 1500;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let detectedOrientation: BoardOrientation | undefined;

  const tick = async (): Promise<void> => {
    try {
      const frame = await capture.capture();
      const result = await readBoardPosition(
        vision,
        frame,
        options.orientation ?? detectedOrientation,
      );
      if (stopped) return;
      // An illegal *position* (say, a pawn shoved to the back rank) comes
      // back as `uncertain` with the raw read attached — that read is
      // exactly the evidence an illegal-move verdict needs, so it feeds the
      // referee like any other observation.
      const placement =
        result.status === 'ok' ? result.placement : result.candidate_placement;
      if (typeof placement === 'string' && placement.length > 0) {
        if (result.status === 'ok' && result.orientation != null) {
          detectedOrientation = result.orientation;
        }
        const event = referee.ingest(placement);
        if (event !== null) onEvent(event);
      }
    } catch (error) {
      if (!stopped) onReadError?.(error);
    } finally {
      if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
    }
  };

  void tick();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
