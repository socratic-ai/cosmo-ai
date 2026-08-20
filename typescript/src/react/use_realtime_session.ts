'use client';

/**
 * ``useRealtimeSession`` — React lifecycle hook for one voice session at a
 * time.
 *
 * The imperative surface (``new RealtimeClient(...)``, ``client.agent(...)
 * .start()``, ``session.end()``) stays the source of truth; this hook is
 * sugar over it for the browser-app shape every example shares, the same
 * way ``RealtimeProvider`` is sugar for reads. It owns the pieces an
 * app otherwise hand-rolls:
 *
 * - one-session-at-a-time semantics: a fresh ``RealtimeClient`` per run,
 *   and on any exit path the spent session is closed so the captured
 *   microphone actually releases — ``phase`` stays ``'ending'`` until the
 *   release lands, so a Start button gated on ``phase === 'idle'`` cannot
 *   open a session whose mic track is still held by the last one;
 * - ownership of the in-flight start: ``end()`` or an unmount during
 *   ``'starting'`` marks the run cancelled, and the session is ended
 *   the moment the start settles instead of going live unowned;
 * - ``ready`` → surfacing server-rejected tool specs (``rejectedTools``,
 *   with ``warning`` as a ready-made notice);
 * - ``session_ended`` → funneling every exit path (End button, server
 *   hangup, network loss) into one teardown, recorded as ``lastEnd``;
 * - start-failure plumbing: the thrown error lands in ``error`` and the
 *   phase returns to ``'idle'``.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { RealtimeAgent, SessionStartOptions } from '../core/agent';
import { log } from '../core/logger';
import { RealtimeClient, type RealtimeClientOptions } from '../core/realtime_client';
import type { RealtimeSession } from '../core/session';
import type { DisconnectReason, SessionLifecycleState } from '../core/state';
import type { RejectedTool } from '../wire/types.gen';

/** Where the hook's one session slot is in its life. ``'ending'`` covers
 *  the gap between an exit and the spent client's mic release landing. */
export type RealtimeSessionPhase = 'idle' | 'starting' | 'live' | 'ending';

/** What one ``start()`` call came to. ``busy``: a run is already underway
 *  (nothing changed). ``failed``: the start threw — ``error`` carries it.
 *  ``ended``: the run was over before it went live — cancelled by ``end()``
 *  or an unmount while connecting, or ended the instant it started. */
export type RealtimeSessionStartResult =
  | { ok: true; session: RealtimeSession }
  | { ok: false; reason: 'busy' | 'failed' | 'ended'; error: Error | null };

/** Typed record of how the last run ended. ``reason`` is the lifecycle
 *  machine's typed reason; ``detail`` carries the server's end slug or a
 *  transport message when one exists. */
export type RealtimeSessionEndSummary = {
  reason: DisconnectReason;
  detail: string | null;
};

export type UseRealtimeSessionOptions = {
  /** Build the agent for one run on the freshly constructed client —
   *  return ``client.agent({...})`` or ``client.catalogAgent(name)``.
   *  Called once per ``start()``; the latest committed value is always
   *  used, so it does not need to be memoized. */
  makeAgent: (client: RealtimeClient) => RealtimeAgent;
  /** Options for each run's ``RealtimeClient``. A client is single-use,
   *  so a new one is constructed per ``start()`` from the latest committed
   *  value — no memoization needed. */
  clientOptions?: RealtimeClientOptions;
};

export type UseRealtimeSessionResult = {
  /** Open a session. Resolves once the run is live — connected enough to
   *  render, though not necessarily ``ready`` yet (await
   *  ``session.waitUntilReady()`` before publishing media) — or with the
   *  typed reason it isn't. A failed start also lands in ``error``. */
  start: (opts?: SessionStartOptions) => Promise<RealtimeSessionStartResult>;
  /** End the run: gracefully for a live session, by cancellation for one
   *  still ``'starting'`` (its client is disconnected the moment the start
   *  settles). A no-op when nothing is underway. */
  end: () => Promise<void>;
  /** Why the last ``start()`` failed; cleared on the next start. Errors
   *  during a live session surface via ``useRealtimeError`` instead. */
  error: Error | null;
  /** Tool specs the server rejected at ``ready``, with reasons. The
   *  session runs without them. Empty outside a run that saw rejections. */
  rejectedTools: RejectedTool[];
  /** Ready-made notice naming the rejected tools, or ``null``. Sugar over
   *  ``rejectedTools`` for apps that don't need their own wording. */
  warning: string | null;
  /** How the last run ended; ``null`` while a run is underway or before
   *  the first one. Cleared on the next start. */
  lastEnd: RealtimeSessionEndSummary | null;
  /** Sugar over ``lastEnd`` for a "call ended" notice: the end's detail or
   *  reason, or ``null`` when the app itself asked for the end. */
  endedReason: string | null;
} & (
  | {
      phase: 'idle' | 'starting' | 'ending';
      client: null;
      session: null;
    }
  | {
      /** ``'live'`` statically implies a non-null ``client``/``session``. */
      phase: 'live';
      client: RealtimeClient;
      session: RealtimeSession;
    }
);

type SessionSlot =
  | { phase: 'idle' | 'starting' | 'ending'; client: null; session: null }
  | { phase: 'live'; client: RealtimeClient; session: RealtimeSession };

/** Exit reasons the app itself asked for — not worth surfacing back. */
const LOCAL_END_REASONS: ReadonlySet<DisconnectReason> = new Set([
  'client_ended',
  'client_closed',
]);

const NO_REJECTED_TOOLS: RejectedTool[] = [];

function endSummaryFromState(
  state: SessionLifecycleState,
  fallbackDetail: string | null,
): RealtimeSessionEndSummary {
  if (state.kind === 'disconnected') {
    return { reason: state.disconnectReason ?? 'transport_error', detail: state.detail ?? null };
  }
  return { reason: 'transport_error', detail: fallbackDetail };
}

export function useRealtimeSession(
  options: UseRealtimeSessionOptions,
): UseRealtimeSessionResult {
  const [slot, setSlot] = useState<SessionSlot>({
    phase: 'idle',
    client: null,
    session: null,
  });
  const [error, setError] = useState<Error | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [rejectedTools, setRejectedTools] = useState<RejectedTool[]>(NO_REJECTED_TOOLS);
  const [lastEnd, setLastEnd] = useState<RealtimeSessionEndSummary | null>(null);

  // Latest committed inputs, read at start() time — callers pass fresh
  // object/function literals every render without retriggering anything.
  // Written from an effect, not during render: an abandoned concurrent
  // render must not publish options the committed tree never saw.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  // Refs mirror the states that gate re-entry: two clicks in one tick must
  // not both pass the phase guard, and teardown must reach the spent client
  // without waiting on a re-render.
  const phaseRef = useRef<RealtimeSessionPhase>('idle');
  const clientRef = useRef<RealtimeClient | null>(null);
  const sessionRef = useRef<RealtimeSession | null>(null);
  /** Set by ``end()`` while a start is in flight; the start settles into a
   *  disconnect instead of going live. */
  const cancelRef = useRef(false);
  /** Set on unmount. No state moves after it; a start still in flight
   *  disconnects its client the moment it settles. */
  const disposedRef = useRef(false);

  const movePhase = useCallback((next: 'idle' | 'starting' | 'ending') => {
    if (disposedRef.current) return;
    phaseRef.current = next;
    setSlot({ phase: next, client: null, session: null });
  }, []);

  const handleEnded = useCallback(
    (spent: RealtimeSession, summary: RealtimeSessionEndSummary) => {
      // A late event off an already-torn-down run must not clobber the
      // state of a newer one.
      if (sessionRef.current !== spent) return;
      clientRef.current = null;
      sessionRef.current = null;
      if (!disposedRef.current) {
        setWarning(null);
        setRejectedTools(NO_REJECTED_TOOLS);
        setLastEnd(summary);
      }
      movePhase('ending');
      void (async () => {
        try {
          // ``close()`` is idempotent and resolves only once teardown —
          // including the mic release — has landed.
          await spent.close();
        } catch (err) {
          log.error('[realtime] close after session end failed', err);
        }
        movePhase('idle');
      })();
    },
    [movePhase],
  );

  const start = useCallback(
    async (opts?: SessionStartOptions): Promise<RealtimeSessionStartResult> => {
      if (disposedRef.current || phaseRef.current !== 'idle') {
        return { ok: false, reason: 'busy', error: null };
      }
      cancelRef.current = false;
      movePhase('starting');
      setError(null);
      setWarning(null);
      setRejectedTools(NO_REJECTED_TOOLS);
      setLastEnd(null);

      const { makeAgent, clientOptions } = optionsRef.current;
      let live: RealtimeClient;
      let started: RealtimeSession;
      try {
        live = new RealtimeClient(clientOptions);
        started = await makeAgent(live).start(opts);
      } catch (err) {
        // agent.start() has already torn its client down on failure —
        // nothing is holding the microphone.
        const error = err instanceof Error ? err : new Error(String(err));
        const cancelled = cancelRef.current || disposedRef.current;
        if (!cancelled) {
          log.error('[realtime] session start failed', err);
          setError(error);
        }
        movePhase('idle');
        return cancelled
          ? { ok: false, reason: 'ended', error }
          : { ok: false, reason: 'failed', error };
      }

      if (cancelRef.current || disposedRef.current) {
        // The owner asked to end (or unmounted) while the start was in
        // flight — the run is over before it went live; release the mic.
        void (async () => {
          try {
            await started.end();
          } catch (err) {
            log.error('[realtime] end after cancelled start failed', err);
          }
          movePhase('idle');
        })();
        return { ok: false, reason: 'ended', error: null };
      }

      clientRef.current = live;
      sessionRef.current = started;

      // ``ready`` is replayed to late subscribers, so a fast connect
      // cannot slip past this.
      started.on('ready', (ev) => {
        if (ev.rejectedTools.length === 0) return;
        setRejectedTools(ev.rejectedTools);
        const names = ev.rejectedTools.map((tool) => tool.name).join(', ');
        setWarning(`The server rejected tools: ${names}`);
      });
      started.on('session_ended', (ev) =>
        handleEnded(started, endSummaryFromState(started.state, ev.reason)),
      );
      // ``session_ended`` is not replayed — an end racing the subscription
      // shows only in the session's latched terminal state.
      const state = started.state;
      if (state.kind === 'disconnected') {
        handleEnded(started, endSummaryFromState(state, null));
        return { ok: false, reason: 'ended', error: null };
      }

      phaseRef.current = 'live';
      setSlot({ phase: 'live', client: live, session: started });
      return { ok: true, session: started };
    },
    [handleEnded, movePhase],
  );

  const end = useCallback(async (): Promise<void> => {
    if (phaseRef.current === 'starting') {
      cancelRef.current = true;
      movePhase('ending');
      return;
    }
    const current = sessionRef.current;
    if (current === null) return;
    // Enter 'ending' before the graceful end, not after it lands —
    // repeated End clicks and Start gating stay deterministic through
    // the whole teardown.
    movePhase('ending');
    try {
      await current.end();
    } catch (err) {
      log.error('[realtime] session end failed', err);
      handleEnded(current, { reason: 'client_ended', detail: null });
    }
  }, [handleEnded, movePhase]);

  useEffect(() => {
    // StrictMode re-runs this effect on the same instance; only the final
    // unmount may leave the hook disposed.
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      const live = sessionRef.current;
      if (live !== null) {
        // The owner unmounted mid-session: release the microphone.
        live.end().catch((err: unknown) => {
          log.error('[realtime] end on unmount failed', err);
        });
      }
    };
  }, []);

  const endedReason =
    lastEnd === null || LOCAL_END_REASONS.has(lastEnd.reason)
      ? null
      : (lastEnd.detail ?? lastEnd.reason);

  return {
    ...slot,
    start,
    end,
    error,
    rejectedTools,
    warning,
    lastEnd,
    endedReason,
  };
}
