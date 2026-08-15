import type { SessionStartTimings } from '../wire/types.gen';

/**
 * Normalized state model for the Realtime SDK.
 *
 * Three independent axes — transport (wire connectivity), agent (LLM
 * activity), and media (mic / screen / output) — each progresses at its
 * own cadence and surfaces different UX cues, so we model them
 * separately rather than collapsing them to a single union.
 */

import type { ErrorEvent, ScreenShareState } from './types';

export type TransportState =
  | 'disconnected'
  | 'requesting-permission'
  | 'connecting'
  | 'connected'
  | 'ready'
  | 'reconnecting'
  | 'disconnecting'
  | 'failed';

/** Typed end reasons for the formal session lifecycle. Cross-SDK
 *  vocabulary — Python's ``DisconnectReason`` is the reference. */
export type DisconnectReason =
  | 'client_ended'
  | 'client_closed'
  | 'handshake_failed'
  | 'server_ended'
  | 'transport_error';

/** Formal connection lifecycle:
 *  ``idle → connecting → connected ↔ reconnecting → disconnected``.
 *  Distinct from ``TransportState`` (the browser-UX axis with
 *  permission/ready/disconnecting phases): this machine is the
 *  cross-SDK session lifecycle with typed end reasons.
 *  ``disconnectReason`` is populated only when ``kind`` is
 *  ``'disconnected'``; ``detail`` carries the server's end slug or a
 *  transport message when one exists. */
export type SessionLifecycleState = {
  kind: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
  disconnectReason?: DisconnectReason;
  detail?: string;
};

export const INITIAL_LIFECYCLE_STATE: SessionLifecycleState = { kind: 'idle' };

export type AgentState = 'idle' | 'listening' | 'thinking' | 'speaking';

export type MicState =
  | 'unknown'
  | 'requesting'
  | 'granted'
  | 'denied'
  | 'muted'
  | 'not-found';

export type OutputState = 'blocked' | 'playing' | 'silent';

export type MediaState = {
  mic: MicState;
  screen: ScreenShareState;
  output: OutputState;
};

/** Connect-latency breakdown: the client-measured phases of this session's
 *  start plus the server's own breakdown from the start response.
 *
 *  ``wsMs`` is the session-start POST, ``roomMs`` the LiveKit join, ``micMs``
 *  the mic publish (``0`` for a session that publishes none), ``totalConnectMs``
 *  the whole connect. ``serverTimings`` is ``null`` on a backend that doesn't
 *  report it; a server phase the serving flow doesn't have reports ``0``
 *  rather than a fabricated split, so a zero there is a real measurement. */
export type SessionConnectTimings = {
  wsMs: number;
  roomMs: number;
  micMs: number;
  totalConnectMs: number;
  serverTimings: SessionStartTimings | null;
};

export type RealtimeSnapshot = {
  transportState: TransportState;
  agentState: AgentState;
  mediaState: MediaState;
  error: ErrorEvent | null;
};

export const INITIAL_MEDIA_STATE: MediaState = {
  mic: 'unknown',
  screen: { kind: 'inactive' },
  output: 'silent',
};

export const INITIAL_SNAPSHOT: RealtimeSnapshot = {
  transportState: 'disconnected',
  agentState: 'idle',
  mediaState: INITIAL_MEDIA_STATE,
  error: null,
};
