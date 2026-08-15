/**
 * Tight public event surface for ``RealtimeClient``.
 *
 * The client emits six logical events — three normalized state axes
 * (transport / agent / media), three payload events (transcript delta,
 * tool call, tool result), and ``error``. Every subscriber — state
 * stores, reconnect listeners, UI adapters — wires through this
 * one mechanism; none reach into the client's message-handler
 * internals.
 *
 * The emitter is intentionally minimal — type-safe ``on(event,
 * handler)`` with an unsubscribe return. No once / wildcard / priority
 * — those belong in app-level subscribers if ever needed.
 */

import { log } from './logger';
import type {
  UserSpeechTimeoutEvent as WireUserSpeechTimeoutEvent,
  RejectedTool,
} from '../wire/types.gen';

import type {
  AgentState,
  MediaState,
  SessionLifecycleState,
  TransportState,
} from './state';
import type { ErrorEvent } from './types';

export type TranscriptDeltaEvent = {
  /** Stable per-delta id: ``${turnId}-${seq}``. Consumers coalesce by
   *  (turnId, role) — never by message identity. */
  id: string;
  /** Shared across one bot or user turn. Resets on ``turn-complete``. */
  turnId: string;
  role: 'user' | 'assistant';
  text: string;
  isFinal: boolean;
  /** ``true`` = delta to append to last bubble with matching turnId;
   *  ``false`` = new bubble. The client never coalesces — UI does. */
  append: boolean;
};

export type ModelTextEvent = {
  /** Streaming text fragment from the model's ``model_turn.parts[].text``
   *  channel. NOT a transcription of spoken audio — see ``transcript``
   *  for that. In AUDIO sessions Gemini may emit function-call narration
   *  or other written-style text here that the listener never heard.
   *  Consumers building a "what was spoken" UI should ignore this. */
  text: string;
  isFinal: boolean;
};

export type ToolCallEvent = {
  toolCallId: string;
  name: string;
};

export type ToolResultEvent = {
  toolCallId: string;
  ok: boolean;
  summary: string | null;
};

export type VolumeEvent = { mic: number; output: number };

/** Resolved-agent summary echoed on ``ready`` when the session referenced
 *  a registry agent (``AgentConfig.name``). Informational only — never
 *  authoritative; clients don't act on it. */
export type ResolvedAgentInfo = {
  /** Machine handle of the registry agent the session resolved. */
  name: string;
  /** Effective tool names the session runs with. */
  tools: string[];
};

export type ReadyEvent = {
  sessionId: string;
  /** Tool specs the server refused (unknown server-tool names, sanitization,
   *  schema caps), with the reason. The session still starts without them. */
  rejectedTools: RejectedTool[];
  /** Server-enforced session duration cap (seconds), measured from session
   *  start server-side. ``null`` = no cap. Lets the UI render its own
   *  countdown without depending on the last-moment warning frame. */
  maxSessionSeconds: number | null;
  /** Resolved registry agent for an ``AgentConfig.name`` session;
   *  ``null`` for a purely inline agent. */
  agent: ResolvedAgentInfo | null;
};

export type ToolDispatchStartedEvent = {
  toolCallId: string;
  name: string;
};

export type UsageEvent = {
  /** Cumulative totals for the session so far, not a per-turn delta. Each
   *  event supersedes the previous one. A provider that reports no usage
   *  emits none at all, so absence is not zero. */
  inputTextTokens: number;
  inputImageTokens: number;
  inputAudioTokens: number;
  inputCachedTokens: number;
  outputTextTokens: number;
  outputAudioTokens: number;
  totalTokens: number;
};

export type SessionStateWriteEvent = {
  /** Full canonical state after the merge — not a delta. */
  state: Record<string, unknown>;
  /** Keys touched by the ``set_state`` write that produced this event. */
  updatedKeys: string[];
  /** Advisory schema findings (e.g. required capture still empty on a
   *  stage advance). The model saw the same list in its tool result. */
  warnings: string[];
  /** ``state.stage`` hoisted by the server for the live stage timeline. */
  stage: string | null;
};

export type ReconnectingEvent = {
  /** Optional ETA hint from the server. */
  secondsRemaining: number | null;
};

export type SessionEndingSoonEvent = {
  /** How long until the server ends the session. */
  secondsRemaining: number;
  /** Stable slug (e.g. ``max_session_duration``). */
  reason: string;
};

export type SessionEndedEvent = {
  /** Stable slug (e.g. ``max_session_duration``). */
  reason: string;
};

export type TurnCompleteEvent = {
  role: 'user' | 'assistant';
};

export type PongEvent = Record<string, never>;

/** A server-runtime silence timeout fired: the user was silent past a
 *  configured threshold and the server performed ``action``. Observability
 *  only — the server already acted. */
export type UserSpeechTimeoutEvent = {
  sessionId: string;
  silenceMs: number;
  triggerCount: number;
  maxCount: number;
  action: WireUserSpeechTimeoutEvent['action'];
};

export type RealtimeEventMap = {
  transport_state: TransportState;
  agent_state: AgentState;
  media_state: MediaState;
  /** Formal session lifecycle (``idle → connecting → connected ↔
   *  reconnecting → disconnected``) with typed end reasons. Drives
   *  ``RealtimeSession.state`` and the stream's terminal item. The current
   *  state is replayed to each new subscriber, so attaching after
   *  ``agent.start()`` resolves misses nothing. */
  lifecycle: SessionLifecycleState;
  transcript: TranscriptDeltaEvent;
  model_text: ModelTextEvent;
  tool_call: ToolCallEvent;
  tool_dispatch_started: ToolDispatchStartedEvent;
  tool_result: ToolResultEvent;
  /** Durable session state changed (a server-side ``set_state`` write). */
  session_state: SessionStateWriteEvent;
  /** Cumulative token usage for the session, split by direction and
   *  modality. Each event supersedes the previous one. */
  usage: UsageEvent;
  volume: VolumeEvent;
  /** Latest terminal-ish error, or ``null`` when the SDK has cleared
   *  back to a healthy state (e.g. on the next session start). React
   *  consumers via ``useRealtimeError()`` need both transitions to
   *  hide a stale banner after a recovery. */
  error: ErrorEvent | null;
  /** Fires once per session when the server sends ``ready``; replayed to
   *  subscribers that attach after it fired. */
  ready: ReadyEvent;
  /** Fires once per session the instant the session-start POST
   *  returns the server-minted ``session_id`` — well before
   *  ``ready`` (which waits for the realtime model to handshake
   *  over the data channel). Consumers that need a per-session id
   *  but not full transport-ready state (e.g. polling per-session
   *  REST endpoints) bind here. */
  session_started: { sessionId: string };
  /** Server is rotating the upstream model; session stays live. */
  reconnecting: ReconnectingEvent;
  /** Server will end the session shortly (e.g. max-duration cap); the
   *  session stays live until ``session_ended``. */
  session_ending_soon: SessionEndingSoonEvent;
  /** Fires exactly once when the session reaches its terminal state, on
   *  any exit path — server end, client ``end()``/``close()``, transport
   *  failure. ``reason`` is the server's slug when the server ended it,
   *  otherwise the disconnect reason (e.g. ``client_ended``). */
  session_ended: SessionEndedEvent;
  /** End-of-turn marker; fires after a turn's transcript + tool activity. */
  turn_complete: TurnCompleteEvent;
  /** Reply to ``sendPing()``; surfaced for liveness checks. */
  pong: PongEvent;
  /** A server-runtime silence timeout fired (``user-speech-timeout``). */
  user_speech_timeout: UserSpeechTimeoutEvent;
};

export type RealtimeEventName = keyof RealtimeEventMap;

export type Unsubscribe = () => void;

type Handler<E extends RealtimeEventName> = (payload: RealtimeEventMap[E]) => void;

type HandlerSets = { [E in RealtimeEventName]?: Set<Handler<E>> };

/**
 * Type-safe in-process event emitter for ``RealtimeClient``.
 *
 * Stays in-package and intentionally minimal — adding extra surface
 * (wildcards, priorities) belongs in app code, not this boundary.
 */
type SubscriberChangeHandler = (count: number) => void;
type SubscriberChangeSets = { [E in RealtimeEventName]?: Set<SubscriberChangeHandler> };

export class RealtimeEventEmitter {
  private handlers: HandlerSets = {};
  private subscriberChangeHandlers: SubscriberChangeSets = {};

  on<E extends RealtimeEventName>(event: E, handler: Handler<E>): Unsubscribe {
    let set = this.handlers[event] as Set<Handler<E>> | undefined;
    if (set === undefined) {
      set = new Set();
      this.handlers[event] = set as HandlerSets[E];
    }
    set.add(handler);
    this.notifySubscriberChange(event, set.size);
    return () => {
      if (set === undefined) return;
      const removed = set.delete(handler);
      if (removed) this.notifySubscriberChange(event, set.size);
    };
  }

  emit<E extends RealtimeEventName>(event: E, payload: RealtimeEventMap[E]): void {
    const set = this.handlers[event] as Set<Handler<E>> | undefined;
    if (set === undefined) return;
    for (const handler of set) {
      try {
        handler(payload);
      } catch (err) {
        log.error(`[realtime] event handler for ${event} threw`, err);
      }
    }
  }

  listenerCount(event: RealtimeEventName): number {
    const set = this.handlers[event];
    return set ? set.size : 0;
  }

  onSubscriberChange(
    event: RealtimeEventName,
    cb: SubscriberChangeHandler,
  ): Unsubscribe {
    let set = this.subscriberChangeHandlers[event];
    if (set === undefined) {
      set = new Set();
      this.subscriberChangeHandlers[event] = set;
    }
    set.add(cb);
    return () => {
      set?.delete(cb);
    };
  }

  private notifySubscriberChange(event: RealtimeEventName, count: number): void {
    const set = this.subscriberChangeHandlers[event];
    if (set === undefined) return;
    for (const cb of set) {
      try {
        cb(count);
      } catch (err) {
        log.error(`[realtime] subscriber-change handler for ${event} threw`, err);
      }
    }
  }

  clear(): void {
    this.handlers = {};
  }
}
