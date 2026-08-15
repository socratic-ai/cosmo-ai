import { useEffect, useMemo, useRef } from 'react';

import type { GameStore } from '../game/state';
import { BOARD_DOCUMENT } from './board_document';

/**
 * The render surface: a sandboxed iframe (`allow-scripts` only, so the board
 * runs on an opaque origin — no cookies, no storage, no reach into this page)
 * fed the full game state on every change. The sandbox does not restrict the
 * network; the board document's own CSP is what keeps it offline. The frame
 * announces `board-ready` before it can paint, so renders are held until then
 * rather than lost.
 */
export function BoardFrame({
  store,
  onBoardEvent,
}: {
  store: GameStore;
  /** Fired for events the board reports upward (e.g. the charades timer
   *  running out) — the page relays them to the agent as context notes. */
  onBoardEvent?: (event: string) => void;
}) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const readyRef = useRef(false);
  const onBoardEventRef = useRef(onBoardEvent);
  onBoardEventRef.current = onBoardEvent;

  // The board's CSP denies everything by default, so the one asset it loads
  // has to be named: the backdrop goes in as an absolute URL and its origin
  // as the `img-src` allowance. Without them the board falls back to its
  // gradient.
  const boardDoc = useMemo(() => {
    const stageBg = new URL('stage-bg.jpg', document.baseURI);
    return BOARD_DOCUMENT.replace('__STAGE_BG__', stageBg.href).replace(
      '__STAGE_BG_ORIGIN__',
      stageBg.origin,
    );
  }, []);

  useEffect(() => {
    const frame = frameRef.current;
    if (frame === null) return;

    const post = () => {
      if (!readyRef.current) return;
      const { stage, teams } = store.getState();
      // Opaque origin on the sandboxed side, so '*' is the only usable
      // target; the message is the board's own content, nothing sensitive.
      frame.contentWindow?.postMessage({ type: 'render', stage, teams }, '*');
    };

    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow) return;
      const data = event.data as { type?: string; event?: string } | null;
      if (data?.type === 'board-ready') {
        readyRef.current = true;
        post();
      } else if (data?.type === 'board-event' && typeof data.event === 'string') {
        onBoardEventRef.current?.(data.event);
      }
    };

    window.addEventListener('message', onMessage);
    const unsubscribe = store.subscribe(post);
    return () => {
      window.removeEventListener('message', onMessage);
      unsubscribe();
      readyRef.current = false;
    };
  }, [store]);

  return (
    <iframe
      ref={frameRef}
      className="board-frame"
      title="Game board"
      sandbox="allow-scripts"
      srcDoc={boardDoc}
    />
  );
}
