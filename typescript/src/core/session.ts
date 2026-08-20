/**
 * ``RealtimeSession`` — one live run of an agent.
 *
 * Created by ``RealtimeAgent.start()``; owns its ``SessionEngine``
 * (transport, lifecycle, snapshot, media state), so N sessions on one
 * client are fully independent — separate streams, separate state.
 *
 * Events are consumable two ways, matching the cross-SDK pattern:
 *
 * - callbacks: ``session.on('transcript', …)`` — the same typed event map
 *   the engine emits (UI-normalized payloads);
 * - async iteration: ``for await (const event of session)`` — the wire-level
 *   event stream (Python's ``async for event in session`` is the reference;
 *   ``tests/test_session_stream.py`` is the spec). Unknown event types
 *   surface as ``{type: 'unknown'}`` items and never terminate the stream;
 *   a ``session-ended`` item is always the final one.
 *
 * The connection lifecycle is a formal state machine
 * (``idle → connecting → connected ↔ reconnecting → disconnected``) with
 * typed end reasons — see ``SessionLifecycleState`` in ``./state``.
 */

import { log } from './logger';
import type { DialResult } from '../transport/dial';
import { UsageError, type SessionUsage } from './usage';
import type {
  RealtimeInboundMessage,
  RealtimeServerMessage,
} from '../transport/envelope';
import type {
  VideoStreamHandle,
  VideoStreamOptions,
} from '../transport/types';

import type { SessionEngine } from './session_engine';
import type {
  RealtimeEventMap,
  RealtimeEventName,
  Unsubscribe,
} from './events';
import type {
  DisconnectReason,
  RealtimeSnapshot,
  SessionConnectTimings,
  SessionLifecycleState,
} from './state';
import type { ScreenShareState } from './types';


/** Forward-compat stream item for a frame the SDK does not recognize.
 *  ``rawType`` is the wire ``type`` string, or ``null`` when the frame was
 *  not decodable at all — ``rawText`` then carries it verbatim and
 *  ``payload`` is null. Never terminal. Mirrors Python's ``UnknownEvent``. */
export type UnknownEvent = {
  type: 'unknown';
  rawType: string | null;
  payload: Record<string, unknown> | null;
  rawText?: string;
};

/** SDK-local terminal stream item — not a wire frame. Always the final
 *  item the iterator yields for a session that connected; ``reason`` is
 *  the server's end slug when it hung up on purpose, else a default for
 *  the typed disconnect reason. */
export type SessionEndedEventItem = {
  type: 'session-ended';
  reason: string | null;
};

/** Items yielded by ``for await (const event of session)``: external wire
 *  frames verbatim, ``unknown`` for unrecognized types, and the SDK-local
 *  terminal ``session-ended``. The wire ``session-ended`` frame itself is
 *  folded into the terminal item so "session-ended is always final" holds
 *  even when the server's notice races later frames. */
export type RealtimeSessionEvent =
  | Exclude<RealtimeServerMessage, { type: 'session-ended' }>
  | SessionEndedEventItem
  | UnknownEvent;

/** Wire ``type`` strings the stream passes through verbatim. Anything
 *  else becomes an ``unknown`` item (never terminal). */
const KNOWN_STREAM_TYPES: ReadonlySet<string> = new Set([
  'ready',
  'transcript',
  'model-text',
  'turn-complete',
  'user-started-speaking',
  'user-stopped-speaking',
  'user-speech-timeout',
  'bot-started-speaking',
  'bot-stopped-speaking',
  'bot-llm-started',
  'bot-llm-stopped',
  'bot-tts-started',
  'bot-tts-stopped',
  'tool-call',
  'tool-dispatch-started',
  'tool-result',
  'tool-invocation',
  'cosmo.usage',
  'cosmo.session-state',
  'reconnecting',
  'session-ending-soon',
  'error',
  'pong',
]);

/** Queue bound, mirroring Python's ``_MAX_QUEUED_EVENTS``: a consumer that
 *  stops pulling drops overflow events (logged) instead of growing without
 *  bound; terminal items evict a buffered event rather than being lost. */
const MAX_QUEUED_EVENTS = 1024;

const DEFAULT_ENDED_REASON: Record<DisconnectReason, string> = {
  client_ended: 'client ended',
  client_closed: 'client closed',
  handshake_failed: 'handshake failed',
  server_ended: 'server ended',
  transport_error: 'transport error',
};

/** @internal — see ``RealtimeSession._internal`` for usage notes. */
export type RealtimeSessionInternal = {
  getInputAnalyser: () => AnalyserNode | null;
  getOutputAnalyser: () => AnalyserNode | null;
  subscribeInputAnalyser: (cb: (a: AnalyserNode | null) => void) => Unsubscribe;
  subscribeOutputAnalyser: (cb: (a: AnalyserNode | null) => void) => Unsubscribe;
};

export class RealtimeSession implements AsyncIterable<RealtimeSessionEvent> {
  private readonly engine: SessionEngine;
  private readonly queue: RealtimeSessionEvent[] = [];
  private pendingPull:
    | { resolve: (r: IteratorResult<RealtimeSessionEvent>) => void }
    | null = null;
  private streamEnded = false;
  private terminalQueued = false;
  private droppedEvents = 0;
  /** Latched final lifecycle state. The engine's own machine settles back
   *  to ``idle`` after teardown, but THIS session stays ``disconnected``
   *  forever once it ends. */
  private terminalState: SessionLifecycleState | null = null;
  /** Backend id of THIS run, bound once — to the first ``session_started``
   *  after construction, which is this session's own start. The engine
   *  drops its copy at teardown, so it is not a source that outlives the
   *  run; binding once is what lets ``usage()`` work after the session
   *  ends. */
  private ownSessionId: string | null = null;
  private readonly unsubscribers: Unsubscribe[] = [];

  /** @internal — construct via ``RealtimeAgent.start()``. ``stateUnsub``
   *  is the caller's ``onStateChange`` subscription; the session owns it so
   *  the callback stops at this run's terminal state instead of observing
   *  the engine settle back to ``idle`` after teardown. */
  constructor(engine: SessionEngine, stateUnsub: Unsubscribe | null = null) {
    this.engine = engine;
    if (stateUnsub !== null) this.unsubscribers.push(stateUnsub);
    this.unsubscribers.push(
      engine.subscribeWireMessages((message) => {
        this.onWireMessage(message);
      }),
    );
    this.unsubscribers.push(
      engine.on('session_started', ({ sessionId }) => {
        this.ownSessionId ??= sessionId;
      }),
    );
    this.unsubscribers.push(
      engine.on('lifecycle', (state) => {
        if (state.kind === 'disconnected') this.finishStream(state);
      }),
    );
  }

  // ── Events ───────────────────────────────────────────────────────────

  on<E extends RealtimeEventName>(
    event: E,
    handler: (payload: RealtimeEventMap[E]) => void,
  ): Unsubscribe {
    return this.engine.on(event, handler);
  }

  [Symbol.asyncIterator](): AsyncIterator<RealtimeSessionEvent> {
    return {
      next: (): Promise<IteratorResult<RealtimeSessionEvent>> => {
        const buffered = this.queue.shift();
        if (buffered !== undefined) {
          return Promise.resolve({ value: buffered, done: false });
        }
        if (this.streamEnded) {
          return Promise.resolve({ value: undefined, done: true });
        }
        if (this.pendingPull !== null) {
          return Promise.reject(
            new Error('RealtimeSession supports a single stream consumer.'),
          );
        }
        return new Promise((resolve) => {
          this.pendingPull = { resolve };
        });
      },
    };
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  /** Formal connection state (``idle → connecting → connected ↔
   *  reconnecting → disconnected``) with the typed end reason once
   *  disconnected. */
  get state(): SessionLifecycleState {
    return this.terminalState ?? this.engine.getLifecycleState();
  }

  get sessionId(): string | null {
    return this.engine.getSessionId();
  }

  /** Connect-latency breakdown for this session's start: the client-measured
   *  phases plus the server's own breakdown. ``null`` before the connect
   *  completes; dropped when the session ends. */
  get connectTimings(): SessionConnectTimings | null {
    return this.engine.getConnectTimings();
  }

  /** Gracefully end the session: the transport sends the ``end`` frame and
   *  leaves the room; the stream finishes with reason ``client ended``.
   *  Idempotent. Teardown is immediate — events still in flight are
   *  dropped, so consume the turn's final transcript event before ending
   *  if you need it. */
  async end(): Promise<void> {
    await this.engine.disconnect();
  }

  /** Abrupt local teardown without telling the server — no wire ``end``
   *  frame; the stream finishes with reason ``client closed``. Idempotent. */
  async close(): Promise<void> {
    await this.engine.close();
  }

  waitUntilReady(): Promise<void> {
    return this.engine.waitUntilReady();
  }

  getSnapshot(): RealtimeSnapshot {
    return this.engine.getSnapshot();
  }

  // ── Sends / actions (delegates to this session's engine) ────────────

  sendText(
    content: string,
    options?: { transcript?: boolean },
  ): Promise<void> {
    return this.engine.sendText(content, options);
  }

  /** Give the agent context without asking it anything.
   *
   *  The note lands in the model's context for its next reply and never
   *  becomes a turn of its own: no spoken response, no assistant message,
   *  no interruption of what the agent is saying. Nothing is added to the
   *  transcript either — the user didn't say this.
   *
   *  For live application state — scroll position, selection, current
   *  record, form values. ``sendText`` is the opposite: it asks. */
  sendContext(content: string): Promise<void> {
    return this.engine.sendContext(content);
  }

  sendImage(args: { data: string; mimeType?: string; streamId?: string }): Promise<void> {
    return this.engine.sendImage(args);
  }

  ping(): Promise<void> {
    return this.engine.sendPing();
  }

  /** Signal end-of-turn for manual-VAD turn-taking. */
  sendActivityEnd(): Promise<void> {
    return this.engine.sendActivityEnd();
  }

  /** Place an outbound phone call into this session's room. Throws
   *  ``DialError`` for a malformed number (validated locally, before any
   *  request) or a server rejection. ``callerNumber`` selects the caller id
   *  when the workspace has more than one number provisioned. */
  dial(phoneNumber: string, callerNumber?: string): Promise<DialResult> {
    return this.engine.dial(phoneNumber, callerNumber);
  }

  /** Fetch this session's usage summary: duration, talk time, and token
   *  counts in provider-reported units.
   *
   *  An authenticated REST read, not a data-channel frame — callable while
   *  the session is live and, unlike the sends, after it ends. The detailed
   *  summary is written shortly after the session ends; ``usageStatus``
   *  on the result reports whether it is present yet.
   *
   *  Throws ``UsageError`` on a server rejection or transport failure, or
   *  if the session never started. */
  usage(): Promise<SessionUsage> {
    if (this.ownSessionId === null) {
      return Promise.reject(
        new UsageError('not_started', 'usage requires a started session.'),
      );
    }
    return this.engine.getUsage(this.ownSessionId);
  }

  /** Toggle the mic mute — the local track and the server-side gate.
   *  ``setMuted`` is the cross-SDK session surface (Python ``set_muted``,
   *  Swift ``setMuted``). */
  setMuted(muted: boolean): Promise<void> {
    return this.engine.setMicMuted(muted);
  }

  startScreenShare(): Promise<void> {
    return this.engine.startScreenShare();
  }

  stopScreenShare(): Promise<void> {
    return this.engine.stopScreenShare();
  }

  getScreenShareState(): ScreenShareState {
    return this.engine.getScreenShareState();
  }

  addVideoStream(
    stream: MediaStream,
    options?: VideoStreamOptions,
  ): Promise<VideoStreamHandle> {
    return this.engine.addVideoStream(stream, options);
  }

  removeVideoStream(streamId: VideoStreamHandle): Promise<void> {
    return this.engine.removeVideoStream(streamId);
  }

  /** Take the session's voice with a caller-owned ``MediaStream`` — a Web
   *  Audio graph, a decoded WAV, an ``<audio>`` element's ``captureStream()``,
   *  or a non-default input device. Declares this client the session's voice
   *  and clears the server-side mute gate. A session carries one voice, so the
   *  stream takes it from the microphone until ``stopAudioStream``; starting a
   *  second one throws ``AudioPublishAlreadyActiveError``. */
  startAudioStream(stream: MediaStream): Promise<void> {
    return this.engine.startAudioStream(stream);
  }

  /** Give the voice back to the microphone the stream displaced.
   *  Idempotent. */
  stopAudioStream(): Promise<void> {
    return this.engine.stopAudioStream();
  }

  registerRpcMethod(
    name: string,
    handler: (payload: string) => Promise<string>,
  ): Unsubscribe {
    return this.engine.registerRpcMethod(name, handler);
  }

  attachAudioElement(el: HTMLAudioElement | null): void {
    this.engine.attachAudioElement(el);
  }

  resumeAudioPlayback(): Promise<void> {
    return this.engine.resumeAudioPlayback();
  }

  /** Mark the remote-audio output as blocked (browser refused autoplay)
   *  or unblocked (a user gesture has caused ``play()`` to succeed).
   *  Called by ``<RealtimeAudio />`` from its own ``play``/``pause``
   *  listeners — the SDK's own state machine doesn't observe the audio
   *  element directly, so the React primitive that owns the element is
   *  the source of truth for autoplay status. */
  setOutputBlocked(blocked: boolean): void {
    this.engine.setOutputBlocked(blocked);
  }

  /** Snapshot whether fresh frames are flowing into the model's vision
   *  input. Looks across every published video track (screen-share AND
   *  camera) and picks the most informative answer the model can act on.
   *  Returned shape mirrors the wire output of the desktop adapter's
   *  ``get_current_screen`` tool so the dispatcher can pass it straight
   *  through to the model. */
  getVisionInputStatus(): { captured: boolean; message: string } {
    return this.engine.getVisionInputStatus();
  }

  // ─── Internal hatch ────────────────────────────────────────────────────
  //
  // Raw ``AnalyserNode`` access for waveform UIs. The public surface for
  // audio levels is the ``volume`` event, which carries RMS — enough for a
  // meter, but not for the frequency-domain draw a waveform needs, which is
  // why this hatch exists. Marked ``@internal`` so external consumers know
  // not to depend on it, and bundled into one object so the published
  // ``RealtimeSession`` type keeps a narrow surface. Session-scoped: the
  // analysers belong to this run's engine and go with it.
  /** @internal */
  readonly _internal: RealtimeSessionInternal = {
    getInputAnalyser: () => this.engine.getInputAnalyser(),
    getOutputAnalyser: () => this.engine.getOutputAnalyser(),
    subscribeInputAnalyser: (cb) => this.engine.subscribeInputAnalyser(cb),
    subscribeOutputAnalyser: (cb) => this.engine.subscribeOutputAnalyser(cb),
  };

  // ── Internals: stream plumbing ───────────────────────────────────────

  private onWireMessage(message: RealtimeInboundMessage): void {
    if (this.streamEnded || this.terminalQueued) return;
    if (message.type === null) {
      this.push({
        type: 'unknown',
        rawType: null,
        payload: null,
        rawText: message.raw,
      });
      return;
    }
    const rawType = (message as { type?: unknown }).type;
    if (rawType === 'session-ended') {
      // The server's own end notice is folded into the terminal item the
      // teardown emits (the engine latches the reason) so it is always
      // the stream's final item even if later frames race the close.
      return;
    }
    if (typeof rawType !== 'string' || !KNOWN_STREAM_TYPES.has(rawType)) {
      this.push({
        type: 'unknown',
        rawType: typeof rawType === 'string' ? rawType : null,
        payload: message as unknown as Record<string, unknown>,
      });
      return;
    }
    this.push(message as RealtimeSessionEvent);
  }

  private finishStream(state: SessionLifecycleState): void {
    if (this.streamEnded || this.terminalQueued) return;
    this.terminalState = state;
    // Handshake failures throw from ``agent.start()`` — the stream a
    // caller never received ends empty, mirroring Python.
    if (state.disconnectReason !== 'handshake_failed') {
      const reason =
        state.detail ??
        DEFAULT_ENDED_REASON[state.disconnectReason ?? 'transport_error'];
      this.pushTerminal({ type: 'session-ended', reason });
    }
    this.endStream();
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
  }

  private push(event: RealtimeSessionEvent): void {
    if (this.pendingPull !== null) {
      const pull = this.pendingPull;
      this.pendingPull = null;
      pull.resolve({ value: event, done: false });
      return;
    }
    if (this.queue.length >= MAX_QUEUED_EVENTS) {
      this.droppedEvents += 1;
      log.warn(
        `[realtime] session event queue full — dropped ${String(this.droppedEvents)} event(s)`,
      );
      return;
    }
    this.queue.push(event);
  }

  /** Terminal items survive a full queue by evicting the oldest buffered
   *  event instead of being dropped (Python's ``_put_terminal``). */
  private pushTerminal(event: SessionEndedEventItem): void {
    this.terminalQueued = true;
    if (this.pendingPull !== null) {
      const pull = this.pendingPull;
      this.pendingPull = null;
      pull.resolve({ value: event, done: false });
      return;
    }
    if (this.queue.length >= MAX_QUEUED_EVENTS) {
      this.queue.shift();
    }
    this.queue.push(event);
  }

  private endStream(): void {
    this.streamEnded = true;
    if (this.pendingPull !== null) {
      const pull = this.pendingPull;
      this.pendingPull = null;
      pull.resolve({ value: undefined, done: true });
    }
  }
}
