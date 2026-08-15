import { useCallback, useEffect, useRef, useState } from 'react';

import type { DrawBoxRequest, DrawPointRequest } from 'cosmo-ai';

import { setDrawSurface } from './draw_tools';

// How long a mark stays up. Long enough to look where the agent pointed while
// it is still talking, short enough that a stale mark never outlives the
// moment it referred to.
const MARK_TTL_MS = 20000;
// ``cosmo_detect_objects`` can return several boxes and the model draws them
// one call at a time, so marks accumulate into a small set instead of each
// replacing the last.
const MAX_MARKS = 6;

export type Mark<T> = { id: number; request: T };

function useMarkList<T>(): { marks: Mark<T>[]; add: (request: T) => void; clear: () => void } {
  const [marks, setMarks] = useState<Mark<T>[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const add = useCallback((request: T) => {
    const id = nextId.current++;
    setMarks((prev) => [...prev.slice(-(MAX_MARKS - 1)), { id, request }]);
    timers.current.set(
      id,
      setTimeout(() => {
        timers.current.delete(id);
        setMarks((prev) => prev.filter((mark) => mark.id !== id));
      }, MARK_TTL_MS),
    );
  }, []);

  const clear = useCallback(() => {
    for (const timer of timers.current.values()) clearTimeout(timer);
    timers.current.clear();
    setMarks([]);
  }, []);

  useEffect(() => clear, [clear]);

  return { marks, add, clear };
}

/**
 * Holds the marks the model has asked to draw and registers the mounted view
 * as the draw surface. Marks expire on a TTL and are wiped when the session
 * ends — a box refers to a frame, and once the call is over it means nothing.
 */
export function useDrawMarks(active: boolean): {
  boxes: Mark<DrawBoxRequest>[];
  points: Mark<DrawPointRequest>[];
} {
  const { marks: boxes, add: addBox, clear: clearBoxes } = useMarkList<DrawBoxRequest>();
  const { marks: points, add: addPoint, clear: clearPoints } = useMarkList<DrawPointRequest>();

  useEffect(() => {
    setDrawSurface({ showBox: addBox, showPoint: addPoint });
    return () => setDrawSurface(null);
  }, [addBox, addPoint]);

  useEffect(() => {
    if (active) return;
    clearBoxes();
    clearPoints();
  }, [active, clearBoxes, clearPoints]);

  return { boxes, points };
}
