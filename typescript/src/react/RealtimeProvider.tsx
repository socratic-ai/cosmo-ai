'use client';

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from 'react';

import type { RealtimeSession } from '../core/session';
import type { ErrorEvent } from '../core/types';
import type {
  ToolCallEvent,
  ToolResultEvent,
  Unsubscribe,
} from '../core/events';
import {
  INITIAL_SNAPSHOT,
  type AgentState,
  type MediaState,
  type TransportState,
} from '../core/state';
import { reduceTranscript, type RealtimeTranscriptItem } from '../core/transcript_reducer';

/**
 * Canonical React-first surface for the Cosmo Realtime SDK.
 *
 * The provider is the read side of one ``RealtimeSession``: pass it the
 * session a run returned (``useRealtimeSession``'s ``session``, or your
 * own ``agent.start()`` result) and it publishes a React snapshot through
 * context so the read-only hooks (``useTransportState`` /
 * ``useAgentState`` / ``useMediaState`` / ``useTranscript`` /
 * ``useToolCalls``) read from React state. With no session (``null``,
 * between runs) the snapshot is the initial idle state.
 *
 * Session lifecycle stays the caller's: the provider never starts or
 * ends anything.
 */

export type { RealtimeTranscriptItem };

export type RealtimeToolCallItem = {
  toolCallId: string;
  name: string;
  status: 'in_flight' | 'ok' | 'error';
  summary: string | null;
};

export type RealtimeSnapshotState = {
  transportState: TransportState;
  agentState: AgentState;
  mediaState: MediaState;
  transcript: RealtimeTranscriptItem[];
  toolCalls: RealtimeToolCallItem[];
  /** Most recent terminal-ish error. Cleared back to ``null`` when the
   *  next session is supplied. */
  error: ErrorEvent | null;
};

export type RealtimeContextValue = {
  session: RealtimeSession | null;
  /** Host-supplied ``<audio>`` element ref. Populated by
   *  ``<RealtimeAudio />``; ``null`` when no host element is mounted. */
  audioElementRef: MutableRefObject<HTMLAudioElement | null>;
  snapshot: RealtimeSnapshotState;
};

/** Default maximum number of transcript bubbles kept in the React
 *  snapshot. Configurable via ``RealtimeProvider``'s
 *  ``maxTranscriptLength`` prop — pass ``Infinity`` (or a large
 *  number) to keep unbounded transcript history. The default trades
 *  full history for bounded memory in long sessions; the SDK never
 *  reaches back further than what's in this array. */
const DEFAULT_MAX_TRANSCRIPT_LEN = 12;

/** Seed the provider's React snapshot from whatever the session already
 *  knows. Transcript / tool-call lists are event-stream-derived and
 *  start empty on every session change; lifecycle fields (transport /
 *  agent / media) come from the live session so a provider handed an
 *  already-connected session doesn't briefly show ``disconnected``
 *  until the next event fires. */
function snapshotFromSession(session: RealtimeSession | null): RealtimeSnapshotState {
  const snap = session !== null ? session.getSnapshot() : INITIAL_SNAPSHOT;
  return {
    transportState: snap.transportState,
    agentState: snap.agentState,
    mediaState: snap.mediaState,
    transcript: [],
    toolCalls: [],
    error: snap.error,
  };
}

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

export type RealtimeProviderProps = {
  children: ReactNode;
  /** The run to read from — ``useRealtimeSession``'s ``session``, or your
   *  own ``agent.start()`` result. ``null`` (or omitted) between runs;
   *  the snapshot then reports the initial idle state. Lifecycle is the
   *  caller's responsibility — the provider never ends the session. */
  session?: RealtimeSession | null;
  /** Cap on transcript bubbles retained in the React snapshot. Default
   *  is 12, trading full history for bounded memory in long sessions.
   *  Pass ``Infinity`` (or a large explicit number) to keep unbounded
   *  transcript history. Only affects what ``useTranscript()`` returns;
   *  the underlying ``transcript`` event stream is always complete. */
  maxTranscriptLength?: number;
};

export function RealtimeProvider({
  children,
  session = null,
  maxTranscriptLength = DEFAULT_MAX_TRANSCRIPT_LEN,
}: RealtimeProviderProps) {
  const audioElementRef = useRef<HTMLAudioElement | null>(null);

  const [snapshot, setSnapshot] = useState<RealtimeSnapshotState>(() =>
    snapshotFromSession(session),
  );

  useEffect(() => {
    setSnapshot(snapshotFromSession(session));
    if (session === null) return;
    const unsubs: Unsubscribe[] = [];
    unsubs.push(
      session.on('transport_state', (next) => {
        setSnapshot((prev) => (prev.transportState === next ? prev : { ...prev, transportState: next }));
      }),
    );
    unsubs.push(
      session.on('agent_state', (next) => {
        setSnapshot((prev) => (prev.agentState === next ? prev : { ...prev, agentState: next }));
      }),
    );
    unsubs.push(
      session.on('media_state', (next) => {
        setSnapshot((prev) => ({ ...prev, mediaState: next }));
      }),
    );
    unsubs.push(
      session.on('transcript', (event) => {
        setSnapshot((prev) => ({
          ...prev,
          transcript: reduceTranscript(prev.transcript, event, maxTranscriptLength),
        }));
      }),
    );
    unsubs.push(
      session.on('tool_call', (event) => {
        setSnapshot((prev) => ({
          ...prev,
          toolCalls: reduceToolCall(prev.toolCalls, event),
        }));
      }),
    );
    unsubs.push(
      session.on('tool_result', (event) => {
        setSnapshot((prev) => ({
          ...prev,
          toolCalls: reduceToolResult(prev.toolCalls, event),
        }));
      }),
    );
    unsubs.push(
      session.on('error', (next) => {
        setSnapshot((prev) => (prev.error === next ? prev : { ...prev, error: next }));
      }),
    );
    return () => {
      for (const u of unsubs) u();
    };
  }, [session]);

  const value = useMemo<RealtimeContextValue>(
    () => ({ session, audioElementRef, snapshot }),
    [session, snapshot],
  );
  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

function reduceToolCall(
  current: RealtimeToolCallItem[],
  event: ToolCallEvent,
): RealtimeToolCallItem[] {
  return [
    ...current,
    {
      toolCallId: event.toolCallId,
      name: event.name,
      status: 'in_flight',
      summary: null,
    },
  ];
}

function reduceToolResult(
  current: RealtimeToolCallItem[],
  event: ToolResultEvent,
): RealtimeToolCallItem[] {
  return current.map((entry) =>
    entry.toolCallId === event.toolCallId
      ? { ...entry, status: event.ok ? 'ok' : 'error', summary: event.summary }
      : entry,
  );
}

function useRealtimeContext(): RealtimeContextValue {
  const ctx = useContext(RealtimeContext);
  if (!ctx) {
    throw new Error(
      'Cosmo realtime hooks and components must be used inside <RealtimeProvider>.',
    );
  }
  return ctx;
}

/** The provider's current session, or ``null`` between runs. For
 *  imperative calls (``sendText``, ``setMuted``, …) from components that
 *  don't own the run themselves. */
export function useRealtimeSessionContext(): RealtimeSession | null {
  return useRealtimeContext().session;
}

export function useRealtimeSnapshot(): RealtimeSnapshotState {
  return useRealtimeContext().snapshot;
}

/** Internal: the ref shared between ``<RealtimeAudio />`` and
 *  ``<StartAudio />``. Not exported from the package surface — it's an
 *  implementation detail of how the autoplay-unlock primitive finds
 *  the element to ``play()`` on. */
export function useRealtimeAudioElementRef(): MutableRefObject<HTMLAudioElement | null> {
  return useRealtimeContext().audioElementRef;
}

/** @deprecated Renamed to ``RealtimeProvider``. This alias keeps working
 *  and will be removed in a future release. */
export const CosmoRealtimeProvider = RealtimeProvider;

/** @deprecated Renamed to ``RealtimeProviderProps``. This alias keeps
 *  working and will be removed in a future release. */
export type CosmoRealtimeProviderProps = RealtimeProviderProps;
