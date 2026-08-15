/**
 * Read-only React hooks that publish the normalized SDK state
 * (transport / agent / media) plus the transcript and tool-call
 * streams.
 *
 * Imperative entry points (start / end / sendText / setMicMuted /
 * attachAudioElement) live on the client returned by
 * ``useRealtimeClient`` — these hooks are purely for reading. Each
 * hook is backed by the provider's React snapshot derived from the
 * ``RealtimeClient`` event stream, so the SDK has no app-internal
 * state dependency.
 */

import { useEffect, useState } from 'react';

import type { AgentState, MediaState, TransportState } from '../core/state';
import type { ErrorEvent } from '../core/types';

import {
  useRealtimeClient,
  useRealtimeSnapshot,
  type RealtimeToolCallItem,
  type RealtimeTranscriptItem,
} from './RealtimeProvider';

export function useTransportState(): TransportState {
  return useRealtimeSnapshot().transportState;
}

export function useAgentState(): AgentState {
  return useRealtimeSnapshot().agentState;
}

export function useMediaState(): MediaState {
  return useRealtimeSnapshot().mediaState;
}

export type UseTranscriptOptions = {
  /** Cap the returned slice to the last ``limit`` entries. The provider
   *  already caps internally; this is for consumers that want to render
   *  even fewer (e.g. a compact toolbar preview). Omit for the full
   *  in-memory array. */
  limit?: number;
};

export function useTranscript(
  options: UseTranscriptOptions = {},
): RealtimeTranscriptItem[] {
  const { limit } = options;
  const transcript = useRealtimeSnapshot().transcript;
  if (limit === undefined || transcript.length <= limit) return transcript;
  return transcript.slice(-limit);
}

export function useToolCalls(): RealtimeToolCallItem[] {
  return useRealtimeSnapshot().toolCalls;
}

/** Most recent terminal-ish error reported by the SDK, or ``null`` if
 *  the session is healthy. Cleared on a successful ``connect()`` reset. */
export function useRealtimeError(): ErrorEvent | null {
  return useRealtimeSnapshot().error;
}

function useVolumeChannel(channel: 'mic' | 'output'): number {
  const client = useRealtimeClient();
  const [level, setLevel] = useState<number>(0);
  useEffect(() => {
    const unsub = client.on('volume', (e) => {
      setLevel(channel === 'mic' ? e.mic : e.output);
    });
    return () => {
      unsub();
      setLevel(0);
    };
  }, [client, channel]);
  return level;
}

export function useMicLevel(): number {
  return useVolumeChannel('mic');
}

export function useOutputLevel(): number {
  return useVolumeChannel('output');
}
