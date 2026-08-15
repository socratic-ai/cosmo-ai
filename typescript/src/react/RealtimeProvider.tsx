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

import { RealtimeClient, type RealtimeClientOptions } from '../core/realtime_client';
import type { ErrorEvent } from '../core/types';
import type {
  RealtimeEventMap,
  RealtimeEventName,
  ToolCallEvent,
  ToolResultEvent,
  Unsubscribe,
} from '../core/events';
import type { AgentState, MediaState, TransportState } from '../core/state';
import { reduceTranscript, type RealtimeTranscriptItem } from '../core/transcript_reducer';

/**
 * Canonical React-first surface for the Cosmo Realtime SDK.
 *
 * Two configurations are supported:
 *
 *  - ``<CosmoRealtimeProvider client={myClient}>`` — host supplies a
 *    constructed ``RealtimeClient``. Lifecycle is the host's; the
 *    provider does NOT disconnect on unmount.
 *  - ``<CosmoRealtimeProvider getAuthHeaders={…}>`` — provider constructs the
 *    underlying ``RealtimeClient`` and owns its lifecycle; ``disconnect()``
 *    runs on unmount or when a construction prop changes.
 *
 * The provider subscribes to the client's typed event stream and
 * publishes a React snapshot through context so the read-only hooks
 * (``useTransportState`` / ``useAgentState`` / ``useMediaState`` /
 * ``useTranscript`` / ``useToolCalls``) read from React state.
 */

/** Methods every consumer of the context can call on the client. */
export type RealtimeClientLike = Pick<
  RealtimeClient,
  | 'agent'
  | 'disconnect'
  | 'waitUntilReady'
  | 'sendText'
  | 'sendContext'
  | 'dial'
  | 'registerRpcMethod'
  | 'setMicMuted'
  | 'setOutputBlocked'
  | 'resumeAudioPlayback'
  | 'startScreenShare'
  | 'stopScreenShare'
  | 'getVisionInputStatus'
  | 'addVideoStream'
  | 'removeVideoStream'
  | 'startAudioStream'
  | 'stopAudioStream'
  | 'attachAudioElement'
  | 'isActive'
  | 'getSnapshot'
> & {
  on<E extends RealtimeEventName>(
    event: E,
    handler: (payload: RealtimeEventMap[E]) => void,
  ): Unsubscribe;
};

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
  /** Most recent terminal-ish error. Cleared back to ``null`` on the
   *  next successful session start. */
  error: ErrorEvent | null;
};

export type RealtimeContextValue = {
  client: RealtimeClientLike;
  /** Host-supplied ``<audio>`` element ref. Populated by
   *  ``<RealtimeAudio />``; ``null`` when no host element is mounted. */
  audioElementRef: MutableRefObject<HTMLAudioElement | null>;
  snapshot: RealtimeSnapshotState;
};

/** Default maximum number of transcript bubbles kept in the React
 *  snapshot. Configurable via ``CosmoRealtimeProvider``'s
 *  ``maxTranscriptLength`` prop — pass ``Infinity`` (or a large
 *  number) to keep unbounded transcript history. The default trades
 *  full history for bounded memory in long sessions; the SDK never
 *  reaches back further than what's in this array. */
const DEFAULT_MAX_TRANSCRIPT_LEN = 12;

/** Seed the provider's React snapshot from whatever the client already
 *  knows. Transcript / tool-call lists are event-stream-derived and
 *  start empty on every mount; lifecycle fields (transport / agent /
 *  media) come from the live client so a provider mounted around an
 *  already-connected client doesn't briefly show ``disconnected``
 *  until the next event fires. */
function snapshotFromClient(client: RealtimeClientLike): RealtimeSnapshotState {
  const snap = client.getSnapshot();
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

export type CosmoRealtimeProviderProps = {
  children: ReactNode;
  /** Pre-constructed client. Lifecycle is the caller's responsibility —
   *  the provider does not call ``disconnect()`` on unmount. Takes
   *  precedence over the construction props below. */
  client?: RealtimeClientLike;
  /** Auth header resolver, forwarded into the provider-owned client.
   *  Identity matters: changing it rebuilds the client. Wrap in
   *  ``useCallback`` if the function would otherwise be recreated each
   *  render. Ignored when ``client`` is supplied. */
  getAuthHeaders?: RealtimeClientOptions['getAuthHeaders'];
  /** Override the underlying transport factory for the provider-owned
   *  client. Identity matters; memoise on the caller side. Ignored when
   *  ``client`` is supplied. */
  transportFactory?: RealtimeClientOptions['transportFactory'];
  /** Cap on transcript bubbles retained in the React snapshot. Default
   *  is 12, trading full history for bounded memory in long sessions.
   *  Pass ``Infinity`` (or a large explicit number) to keep unbounded
   *  transcript history. Only affects what ``useTranscript()`` returns;
   *  the underlying ``transcript`` event stream is always complete. */
  maxTranscriptLength?: number;
};

export function CosmoRealtimeProvider({
  children,
  client,
  getAuthHeaders,
  transportFactory,
  maxTranscriptLength = DEFAULT_MAX_TRANSCRIPT_LEN,
}: CosmoRealtimeProviderProps) {
  const audioElementRef = useRef<HTMLAudioElement | null>(null);

  const { client: resolvedClient, ownedByProvider } = useMemo<{
    client: RealtimeClientLike;
    ownedByProvider: boolean;
  }>(() => {
    if (client) return { client, ownedByProvider: false };
    const opts: RealtimeClientOptions = {};
    if (getAuthHeaders) opts.getAuthHeaders = getAuthHeaders;
    if (transportFactory) opts.transportFactory = transportFactory;
    return { client: new RealtimeClient(opts), ownedByProvider: true };
  }, [client, getAuthHeaders, transportFactory]);

  useEffect(() => {
    if (!ownedByProvider) return;
    const owned = resolvedClient as unknown as RealtimeClient;
    return () => {
      void owned.disconnect();
    };
  }, [ownedByProvider, resolvedClient]);

  const [snapshot, setSnapshot] = useState<RealtimeSnapshotState>(() =>
    snapshotFromClient(resolvedClient),
  );

  useEffect(() => {
    setSnapshot(snapshotFromClient(resolvedClient));
    const unsubs: Unsubscribe[] = [];
    unsubs.push(
      resolvedClient.on('transport_state', (next) => {
        setSnapshot((prev) => (prev.transportState === next ? prev : { ...prev, transportState: next }));
      }),
    );
    unsubs.push(
      resolvedClient.on('agent_state', (next) => {
        setSnapshot((prev) => (prev.agentState === next ? prev : { ...prev, agentState: next }));
      }),
    );
    unsubs.push(
      resolvedClient.on('media_state', (next) => {
        setSnapshot((prev) => ({ ...prev, mediaState: next }));
      }),
    );
    unsubs.push(
      resolvedClient.on('transcript', (event) => {
        setSnapshot((prev) => ({
          ...prev,
          transcript: reduceTranscript(prev.transcript, event, maxTranscriptLength),
        }));
      }),
    );
    unsubs.push(
      resolvedClient.on('tool_call', (event) => {
        setSnapshot((prev) => ({
          ...prev,
          toolCalls: reduceToolCall(prev.toolCalls, event),
        }));
      }),
    );
    unsubs.push(
      resolvedClient.on('tool_result', (event) => {
        setSnapshot((prev) => ({
          ...prev,
          toolCalls: reduceToolResult(prev.toolCalls, event),
        }));
      }),
    );
    unsubs.push(
      resolvedClient.on('error', (next) => {
        setSnapshot((prev) => (prev.error === next ? prev : { ...prev, error: next }));
      }),
    );
    return () => {
      for (const u of unsubs) u();
    };
  }, [resolvedClient]);

  const value = useMemo<RealtimeContextValue>(
    () => ({ client: resolvedClient, audioElementRef, snapshot }),
    [resolvedClient, snapshot],
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
      'Cosmo realtime hooks and components must be used inside <CosmoRealtimeProvider>.',
    );
  }
  return ctx;
}

export function useRealtimeClient(): RealtimeClientLike {
  return useRealtimeContext().client;
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
