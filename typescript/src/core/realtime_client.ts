/**
 * ``RealtimeClient`` — instantiable entry point of the Cosmo Realtime SDK.
 *
 * Owns what outlives any one session: the credential (API key / minted
 * token / host auth), the resolved base URL, and the agent factories.
 * Each ``agent.start()`` creates its own ``SessionEngine`` — transport,
 * state, event stream — so one client runs any number of concurrent
 * sessions, and two clients coexist without tripping over shared state.
 *
 * The client-level session surface (``on``, ``getSnapshot``, ``sendText``,
 * mic/screen/video controls) predates ``RealtimeSession`` and remains for
 * compatibility: it bridges every session's events onto the client emitter
 * and forwards calls to the most recently started live session. Code
 * running sessions concurrently should hold the ``RealtimeSession``
 * objects and use their session-scoped surface instead.
 */

import { SDK_NAME, SDK_VERSION } from '../constants';
import type { SessionConfig } from '../wire/types.gen';
import type { SessionConnectTimings } from './state';

import {
  RealtimeAgent,
  type AgentConfig,
  type CatalogAgentOptions,
  type BackgroundClientToolSpec,
  type ClientToolSpec,
} from './agent';
import type { ScreenLocateTool } from '../tool/screen';
import type { HookEngine } from './hooks';

import { LiveKitTransport } from '../transport/livekit_transport';
import type {
  RealtimeTransport,
  VideoStreamHandle,
  VideoStreamOptions,
} from '../transport/types';
import {
  assertSupportedBaseUrl,
  composeDialUrl,
  composeMintTokenUrl,
  composeStartUrl,
  composeUsageUrl,
  composeVerifyUrl,
} from '../transport/external_session_url';
import { resolveCredentialFromRuntime } from './credentials_file';
import { getVerify, type CredentialInfo } from './verify';
import { getUsage, type SessionUsage } from './usage';
import { validateE164, type DialResult } from '../transport/dial';
import {
  postMintToken,
  CredentialError,
  MintTokenError,
  type MintedToken,
} from './auth';
import { resolveBaseUrl } from './base_url';
import { TokenSource } from './token_source';
import { computeVisionInputStatus } from './vision_input_status';
import { SessionEngine } from './session_engine';
import { RealtimeSession } from './session';

import {
  RealtimeEventEmitter,
  type RealtimeEventMap,
  type RealtimeEventName,
  type Unsubscribe,
} from './events';
import {
  INITIAL_LIFECYCLE_STATE,
  INITIAL_SNAPSHOT,
  type RealtimeSnapshot,
  type SessionLifecycleState,
} from './state';
import {
  NotReadyError,
  type ErrorEvent,
  type ScreenShareState,
} from './types';

export type RealtimeClientOptions = {
  /** Workspace-scoped API key — a server-side secret. Can mint end-user
   *  tokens (``mintToken``) and open sessions.
   *  Provide at most one of ``apiKey`` / ``token``; the
   *  credential rides every Cosmo API request as ``Authorization: Bearer``.
   *  Omit both when the host app supplies its own bearer via
   *  ``getAuthHeaders`` (the Cosmo web app's server-minted JWT flow). */
  apiKey?: string;
  /** A minted end-user JWT (from ``mintToken``), scoped to one external
   *  user. Safe for a browser/device; can open sessions but cannot mint.
   *  Pass a :class:`TokenSource` instead of the raw string and the client
   *  fetches the JWT itself — from your token endpoint
   *  (``TokenSource.endpoint``) or a custom fetcher — re-fetching as
   *  expiry nears, so a long-lived app never handles refresh. */
  token?: string | TokenSource;
  /** Resolve auth headers to attach to the session-start POST. External
   *  consumers supply their own auth (Bearer token, custom header,
   *  etc.) so the SDK never touches the host app's identity layer.
   *  Result keys are merged with the SDK's ``Content-Type``; the
   *  callback may be sync or async. When a credential (``apiKey`` /
   *  ``token``) is also configured, its ``Authorization`` header wins
   *  over one returned here. */
  getAuthHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
  /** Factory used to construct the underlying ``RealtimeTransport`` per
   *  session start. Defaults to ``LiveKitTransport``. */
  transportFactory?: () => RealtimeTransport;
};

/** @internal — see ``RealtimeClient._internal`` for usage notes. */
export type RealtimeClientInternal = {
  getInputAnalyser: () => AnalyserNode | null;
  getOutputAnalyser: () => AnalyserNode | null;
  subscribeInputAnalyser: (cb: (a: AnalyserNode | null) => void) => Unsubscribe;
  subscribeOutputAnalyser: (cb: (a: AnalyserNode | null) => void) => Unsubscribe;
  subscribeScreenShare: (cb: (active: boolean) => void) => Unsubscribe;
};

/** One live engine and the bridge subscriptions that mirror its events
 *  onto the client-level emitter. */
type EngineRecord = {
  engine: SessionEngine;
  unsubs: Unsubscribe[];
  /** Volume alone is gated on client-level demand — producing it costs a
   *  rAF loop per engine, so the bridge only taps it while someone
   *  listens. */
  volumeUnsub: Unsubscribe | null;
};

type BridgedEvent = Exclude<RealtimeEventName, 'volume'>;

// A ``Record`` so a new event name fails compilation here instead of
// silently never reaching client-level subscribers.
const BRIDGED_EVENT_SET: Record<BridgedEvent, true> = {
  transport_state: true,
  agent_state: true,
  media_state: true,
  lifecycle: true,
  transcript: true,
  model_text: true,
  tool_call: true,
  tool_dispatch_started: true,
  tool_result: true,
  session_state: true,
  usage: true,
  error: true,
  ready: true,
  session_started: true,
  reconnecting: true,
  session_ending_soon: true,
  session_ended: true,
  turn_complete: true,
  pong: true,
  user_speech_timeout: true,
};

const BRIDGED_EVENTS: readonly BridgedEvent[] = Object.keys(
  BRIDGED_EVENT_SET,
) as BridgedEvent[];

export class RealtimeClient {
  private readonly emitter = new RealtimeEventEmitter();
  private readonly options: Omit<RealtimeClientOptions, 'apiKey' | 'token'>;
  // ECMAScript #private (not TS ``private``) so the secret is invisible to
  // JSON.stringify / spread / Object.entries — the closest TS gets to the
  // backend's ``SecretStr`` masking convention.
  #credential: string | null;
  /** Set when ``token`` was a :class:`TokenSource` — the credential is then
   *  fetched (and kept fresh) per request instead of stored. */
  readonly #tokenSource: TokenSource | null;
  /** Whether this client can mint (holds an ``apiKey``). */
  #canMint: boolean;
  #baseUrl: string;
  /** Runs the zero-argument resolution chain at most once; ``null`` when a
   *  credential (or ``getAuthHeaders``) was configured explicitly. */
  #credentialResolution: Promise<void> | null = null;
  #needsCredentialResolution: boolean;

  /** The Cosmo API origin this client talks to. Resolved at construction;
   *  a zero-argument client whose key came from the ``cosmo login``
   *  credentials file adopts the profile's ``base_url`` at first use. */
  get baseUrl(): string {
    return this.#baseUrl;
  }

  /** Live engines in start order — the compat surface targets the last. */
  private readonly engineRecords: EngineRecord[] = [];
  private hostAudioElement: HTMLAudioElement | null = null;

  /** Final state of the most recently ended session, so client-level
   *  getters and subscribe-time replay behave across the gap between
   *  sessions exactly as they did when the client held the state itself. */
  private cachedSnapshot: RealtimeSnapshot = { ...INITIAL_SNAPSHOT };
  private cachedLifecycle: SessionLifecycleState = INITIAL_LIFECYCLE_STATE;
  private cachedReady: RealtimeEventMap['ready'] | null = null;
  /** What the aggregated ``error`` event stream last delivered. The cache
   *  above holds only the last-DETACHED engine's state, so a clean session
   *  detaching after a failed one erases the error from it — retraction
   *  must key off what subscribers actually saw, not off the cache. */
  private lastEmittedError: ErrorEvent | null = null;

  private readonly inputAnalyserListeners = new Set<(a: AnalyserNode | null) => void>();
  private readonly outputAnalyserListeners = new Set<(a: AnalyserNode | null) => void>();

  constructor(options: RealtimeClientOptions = {}) {
    const { apiKey, token, ...rest } = options;
    if (apiKey !== undefined && token !== undefined) {
      throw new CredentialError('Provide at most one of apiKey or token, not both.');
    }
    this.#tokenSource = token instanceof TokenSource ? token : null;
    this.#credential = apiKey ?? (typeof token === 'string' ? token : null);
    this.#canMint = apiKey !== undefined;
    this.#needsCredentialResolution =
      apiKey === undefined && token === undefined && rest.getAuthHeaders === undefined;
    this.#baseUrl = resolveBaseUrl();
    this.options = rest;
    this.emitter.onSubscriberChange('volume', (count) => {
      if (count > 0) {
        for (const record of this.engineRecords) {
          record.volumeUnsub ??= this.bridgeEvent(record.engine, 'volume');
        }
      } else {
        for (const record of this.engineRecords) {
          record.volumeUnsub?.();
          record.volumeUnsub = null;
        }
      }
    });
  }

  /** Run the zero-argument resolution chain (``COSMO_API_KEY``, then the
   *  ``cosmo login`` credentials file) exactly once, before the first
   *  request. Off Node, or with nothing to resolve, the client stays
   *  credential-less — the pre-chain behavior. A file credential brings its
   *  own ``base_url``, so this must complete before any URL is composed. */
  async #ensureCredentialResolved(): Promise<void> {
    if (!this.#needsCredentialResolution) return;
    this.#credentialResolution ??= (async () => {
      const resolved = await resolveCredentialFromRuntime();
      if (resolved === null) return;
      this.#credential = resolved.apiKey;
      this.#canMint = true;
      if (resolved.baseUrl !== null) {
        assertSupportedBaseUrl(resolved.baseUrl);
        this.#baseUrl = resolved.baseUrl.replace(/\/+$/, '');
      }
    })();
    return this.#credentialResolution;
  }

  /** Every Cosmo API request's headers: the SDK identity, the caller's
   *  ``getAuthHeaders`` result, and the configured credential's
   *  ``Authorization: Bearer`` overlaid when one is set. */
  private async resolveAuthHeaders(): Promise<Record<string, string>> {
    await this.#ensureCredentialResolved();
    const identity = { 'X-Cosmo-SDK': `${SDK_NAME}/${SDK_VERSION}` };
    const extra = this.options.getAuthHeaders ? await this.options.getAuthHeaders() : {};
    const bearer =
      this.#tokenSource !== null ? await this.#tokenSource._getJwt() : this.#credential;
    if (bearer === null) return { ...identity, ...extra };
    // Header names are case-insensitive on the wire: a caller-supplied
    // `authorization` would survive the spread and get folded together with
    // ours into one comma-joined value by fetch.
    const withoutAuth = Object.fromEntries(
      Object.entries(extra).filter(([name]) => name.toLowerCase() !== 'authorization'),
    );
    return { ...identity, ...withoutAuth, Authorization: `Bearer ${bearer}` };
  }

  /** Check the credential without starting a session (``GET
   *  realtime/verify``).
   *
   *  A free preflight for a startup check or a CI smoke test: it confirms the
   *  credential authenticates against this backend, and the result separates
   *  the failure modes a first session would otherwise conflate —
   *  under-scoped (``canStartSessions``) versus a deployment with no default
   *  voice stack configured (``realtimeVoiceAvailable``).
   *
   *  Throws ``VerifyError`` if the credential is rejected or the
   *  request fails. */
  async verify(): Promise<CredentialInfo> {
    await this.#ensureCredentialResolved();
    return getVerify({
      verifyUrl: composeVerifyUrl(this.baseUrl),
      getAuthHeaders: () => this.resolveAuthHeaders(),
    });
  }

  /** Fetch a session's usage summary (``GET sessions/{id}/usage``):
   *  duration, talk time, and token counts in provider-reported units.
   *
   *  Takes an explicit session id because the engine outlives any one
   *  session — ``RealtimeSession.usage()`` is the id-carrying surface.
   *
   *  Throws ``UsageError`` if the server rejects or the request fails. */
  async getSessionUsage(sessionId: string): Promise<SessionUsage> {
    await this.#ensureCredentialResolved();
    return getUsage({
      sessionId,
      usageUrl: composeUsageUrl(this.baseUrl, sessionId),
      getAuthHeaders: () => this.resolveAuthHeaders(),
    });
  }

  /** Mint a short-lived end-user token for ``externalUserId`` (``POST
   *  auth/token``).
   *
   *  Run this on your backend with an ``apiKey`` client; hand the returned
   *  ``jwt`` to the end user's browser/device, which constructs
   *  ``new RealtimeClient({ token: jwt })`` and opens a session with
   *  ``client.agent({...}).start()``. Idempotent per ``(workspace,
   *  externalUserId)`` — the same
   *  external user maps to the same auto-provisioned project on repeat calls.
   *  ``opts.ttlSeconds`` (60–86400) shortens the 24-hour default lifetime.
   *
   *  Throws ``MintTokenError`` if this client has no ``apiKey`` (a
   *  token- or cookie-credentialed client cannot mint) or the server rejects
   *  it. */
  async mintToken(
    externalUserId: string,
    opts: { ttlSeconds?: number } = {},
  ): Promise<MintedToken> {
    await this.#ensureCredentialResolved();
    if (!this.#canMint) {
      throw new MintTokenError(
        'no_api_key',
        'mintToken requires an apiKey credential — pass apiKey, set ' +
          'COSMO_API_KEY, or sign in with `cosmo login`. A minted token cannot mint.',
      );
    }
    return postMintToken({
      mintUrl: composeMintTokenUrl(this.baseUrl),
      externalUserId,
      ttlSeconds: opts.ttlSeconds,
      getAuthHeaders: () => this.resolveAuthHeaders(),
    });
  }

  // ─── Engine tracking ───────────────────────────────────────────────────

  private createEngine(): SessionEngine {
    return new SessionEngine({
      createTransport: () =>
        this.options.transportFactory
          ? this.options.transportFactory()
          : new LiveKitTransport(),
      startUrl: () => composeStartUrl(this.baseUrl),
      dialUrl: (sessionId) => composeDialUrl(this.baseUrl, sessionId),
      usageUrl: (sessionId) => composeUsageUrl(this.baseUrl, sessionId),
      resolveAuthHeaders: () => this.resolveAuthHeaders(),
      onStartUnauthorized: () => {
        // The fetched token was rejected despite the refresh skew (revoked,
        // or clocks disagree): drop it so the next start fetches fresh.
        this.#tokenSource?._invalidate();
      },
      defaultAudioElement: () => this.hostAudioElement,
    });
  }

  /** The engine the client-level compat surface targets: the most recently
   *  started session still attached. ``null`` between sessions. */
  private compatEngine(): SessionEngine | null {
    const record = this.engineRecords[this.engineRecords.length - 1];
    return record?.engine ?? null;
  }

  private requireEngine(operation: string): SessionEngine {
    const engine = this.compatEngine();
    if (engine === null) {
      throw new NotReadyError(
        `${operation} requires the session to be live, currently ${this.getSnapshot().transportState}.`,
      );
    }
    return engine;
  }

  private bridgeEvent<E extends RealtimeEventName>(
    engine: SessionEngine,
    event: E,
  ): Unsubscribe {
    return engine.emitter.on(event, (payload) => {
      if (event === 'error') {
        this.lastEmittedError = payload as RealtimeEventMap['error'];
      }
      this.emitter.emit(event, payload);
    });
  }

  private emitError(error: ErrorEvent | null): void {
    this.lastEmittedError = error;
    this.emitter.emit('error', error);
  }

  private attachEngine(engine: SessionEngine): EngineRecord {
    const unsubs: Unsubscribe[] = [];
    for (const event of BRIDGED_EVENTS) {
      unsubs.push(this.bridgeEvent(engine, event));
    }
    unsubs.push(
      engine.subscribeInputAnalyser((analyser) => {
        for (const cb of this.inputAnalyserListeners) cb(analyser);
      }),
    );
    unsubs.push(
      engine.subscribeOutputAnalyser((analyser) => {
        for (const cb of this.outputAnalyserListeners) cb(analyser);
      }),
    );
    const record: EngineRecord = { engine, unsubs, volumeUnsub: null };
    if (this.emitter.listenerCount('volume') > 0) {
      record.volumeUnsub = this.bridgeEvent(engine, 'volume');
    }
    unsubs.push(
      engine.emitter.on('lifecycle', (state) => {
        if (state.kind !== 'disconnected') return;
        // The engine's trailing emissions — snapshot reset, the idle
        // transition, teardown's screen-share clear — all run before its
        // first teardown await; detach on the next microtask so
        // client-level subscribers see the full terminal sequence.
        void Promise.resolve().then(() => {
          this.detachEngine(record);
        });
      }),
    );
    this.engineRecords.push(record);
    // A fresh engine starts error-free; retract a dead session's error
    // so ``useRealtimeError`` banners drop on restart, as they did when the
    // client's own snapshot reset did it. The event is withheld only while
    // another LIVE session still carries an error of its own.
    if (this.cachedSnapshot.error !== null) {
      this.cachedSnapshot = { ...this.cachedSnapshot, error: null };
    }
    if (this.lastEmittedError !== null) {
      const otherLiveError = this.engineRecords.some(
        (other) =>
          other !== record &&
          other.engine.isActive() &&
          other.engine.getSnapshot().error !== null,
      );
      if (!otherLiveError) this.emitError(null);
    }
    return record;
  }

  private detachEngine(record: EngineRecord): void {
    const idx = this.engineRecords.indexOf(record);
    if (idx === -1) return;
    this.engineRecords.splice(idx, 1);
    for (const unsub of record.unsubs) unsub();
    record.volumeUnsub?.();
    this.cachedSnapshot = record.engine.getSnapshot();
    this.cachedLifecycle = record.engine.getLifecycleState();
    this.cachedReady = record.engine.getLastReady();
  }

  // ─── Public lifecycle ──────────────────────────────────────────────────

  isActive(): boolean {
    return this.engineRecords.some((record) => record.engine.isActive());
  }

  getSnapshot(): RealtimeSnapshot {
    const engine = this.compatEngine();
    if (engine !== null) return engine.getSnapshot();
    return { ...this.cachedSnapshot };
  }

  /** Build a reusable persona — immutable; open runs with
   *  ``agent.start()``. Fields left unset fall through to the server-side
   *  protocol defaults. */
  agent(config: AgentConfig = {}): RealtimeAgent {
    return new RealtimeAgent(this, { ...config });
  }

  /** Build an agent that runs a workspace catalog agent by machine handle;
   *  the stored config runs verbatim. Only per-run ride-alongs are
   *  accepted (``CatalogAgentOptions``) — no persona parameters except
   *  ``voice``, the one cosmetic override; anything else stored-config is a
   *  type error. Client ``defaults`` do not apply. */
  catalogAgent(name: string, opts: CatalogAgentOptions = {}): RealtimeAgent {
    return new RealtimeAgent(this, {
      name,
      inputs: opts.inputs,
      tools: opts.tools,
      voice: opts.voice,
      hooks: opts.hooks,
    });
  }

  /** Server-minted session id of the most recent live session, available
   *  the instant its session-start POST returns (before ``ready``);
   *  ``null`` when no session is live. */
  getSessionId(): string | null {
    return this.compatEngine()?.getSessionId() ?? null;
  }

  /** Connect-latency breakdown for the most recent live session's start:
   *  the client-measured phases plus the server's own breakdown. ``null``
   *  before the connect completes, and dropped when the session ends. */
  getConnectTimings(): SessionConnectTimings | null {
    return this.compatEngine()?.getConnectTimings() ?? null;
  }

  getLifecycleState(): SessionLifecycleState {
    return this.compatEngine()?.getLifecycleState() ?? this.cachedLifecycle;
  }

  on<E extends RealtimeEventName>(
    event: E,
    handler: (payload: RealtimeEventMap[E]) => void,
  ): Unsubscribe {
    const unsubscribe = this.emitter.on(event, handler);
    // Connect-phase events can fire before ``agent.start()`` resolves, so a
    // subscriber attaching to the returned session would otherwise miss
    // them. Replay current state so subscribe-then-read needs no reconcile.
    if (event === 'lifecycle') {
      (handler as (payload: RealtimeEventMap['lifecycle']) => void)(
        this.getLifecycleState(),
      );
    } else {
      const engine = this.compatEngine();
      const lastReady = engine !== null ? engine.getLastReady() : this.cachedReady;
      if (event === 'ready' && lastReady !== null) {
        (handler as (payload: RealtimeEventMap['ready']) => void)(lastReady);
      }
    }
    return unsubscribe;
  }

  /** @internal — the session factory behind ``RealtimeAgent.start()``:
   *  creates a fresh engine per call, so concurrent starts yield
   *  independent sessions. Takes the prebuilt external ``session-config``
   *  body; the public way to open a session is
   *  ``client.agent({...}).start()``. */
  async _startSession(opts: {
    config: SessionConfig;
    publishMicrophone: boolean;
    clientTools?: readonly (ClientToolSpec | BackgroundClientToolSpec)[];
    screenLocate?: ScreenLocateTool;
    hooks?: HookEngine;
  }): Promise<RealtimeSession> {
    // Credential resolution runs before the engine starts — a file
    // credential can move ``baseUrl``, and the engine composes its
    // session-start URL from it.
    await this.#ensureCredentialResolved();
    const engine = this.createEngine();
    const session = new RealtimeSession(engine);
    const record = this.attachEngine(engine);
    try {
      await engine.start(opts);
    } catch (err) {
      // Failure paths publish a terminal lifecycle that detaches on a
      // microtask; detaching here as well makes the record's removal
      // deterministic before the caller's catch runs, and covers a
      // transport factory that threw before any lifecycle moved.
      this.detachEngine(record);
      throw err;
    }
    return session;
  }

  /** Gracefully end every live session on this client; with none live,
   *  resets the client-level compat state the last session left behind. To
   *  end one of several concurrent sessions, call ``session.end()`` on
   *  it. */
  async disconnect(): Promise<void> {
    await this.shutdownAll('disconnect');
  }

  /** Abrupt local teardown of every live session without the graceful wire
   *  ``end`` frame; each stream finishes with reason ``client closed``.
   *  Idempotent. */
  async close(): Promise<void> {
    await this.shutdownAll('close');
  }

  private async shutdownAll(mode: 'disconnect' | 'close'): Promise<void> {
    if (this.engineRecords.length === 0) {
      this.resetCachedState();
      return;
    }
    // Every engine tears down even if one rejects; the first failure still
    // surfaces to the caller.
    const results = await Promise.allSettled(
      [...this.engineRecords].map((record) =>
        mode === 'disconnect' ? record.engine.disconnect() : record.engine.close(),
      ),
    );
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failure !== undefined) throw failure.reason;
  }

  /** Return the between-sessions cache to its initial state, emitting only
   *  the transitions consumers can observe — so ``disconnect()`` after a
   *  session already ended clears the leftover snapshot (a server-ended
   *  session's ``ready`` transport state, a failed session's error) while a
   *  pristine client stays silent. */
  private resetCachedState(): void {
    const prevSnapshot = this.cachedSnapshot;
    const prevLifecycle = this.cachedLifecycle;
    this.cachedSnapshot = { ...INITIAL_SNAPSHOT };
    this.cachedLifecycle = INITIAL_LIFECYCLE_STATE;
    this.cachedReady = null;
    if (prevSnapshot.transportState !== INITIAL_SNAPSHOT.transportState) {
      this.emitter.emit('transport_state', INITIAL_SNAPSHOT.transportState);
    }
    if (prevSnapshot.agentState !== INITIAL_SNAPSHOT.agentState) {
      this.emitter.emit('agent_state', INITIAL_SNAPSHOT.agentState);
    }
    if (prevSnapshot.mediaState !== INITIAL_SNAPSHOT.mediaState) {
      this.emitter.emit('media_state', INITIAL_SNAPSHOT.mediaState);
    }
    if (this.lastEmittedError !== null) this.emitError(null);
    if (prevLifecycle.kind !== 'idle') {
      this.emitter.emit('lifecycle', INITIAL_LIFECYCLE_STATE);
    }
  }

  /** Send a text turn. ``transcript: false`` keeps the sent text out of the
   *  local transcript, for context notes the user never typed and shouldn't
   *  see. */
  async sendText(
    content: string,
    options?: { transcript?: boolean },
  ): Promise<void> {
    await this.requireEngine('sendText').sendText(content, options);
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
  async sendContext(content: string): Promise<void> {
    await this.requireEngine('sendContext').sendContext(content);
  }

  /** Send a single image frame to the agent as base64 JSON. Use for
   *  one-shot captures (a photo, a screenshot, a sampled frame); for
   *  continuous streams prefer ``startScreenShare`` / video tracks. */
  async sendImage(args: {
    /** Base64-encoded image bytes (not raw bytes). */
    data: string;
    mimeType?: string;
    streamId?: string;
  }): Promise<void> {
    await this.requireEngine('sendImage').sendImage(args);
  }

  /** Send a keep-alive ping. Server replies with a ``pong`` event; listen
   *  via ``client.on('pong', …)``. */
  async sendPing(): Promise<void> {
    await this.requireEngine('sendPing').sendPing();
  }

  /** Signal end-of-turn for manual-VAD turn-taking: the agent stops
   *  waiting for further user audio and responds to what it has. Distinct
   *  from ending the session. */
  async sendActivityEnd(): Promise<void> {
    await this.requireEngine('sendActivityEnd').sendActivityEnd();
  }

  /** Place an outbound phone call into the most recent live session's room.
   *  See ``SessionEngine.dial`` for semantics; throws ``DialError`` for a
   *  malformed number (validated locally, before any request) or a server
   *  rejection, and ``NotReadyError`` when no session has started. */
  async dial(phoneNumber: string, callerNumber?: string): Promise<DialResult> {
    const engine = this.compatEngine();
    if (engine === null) {
      // Match the live path's order: number validation precedes the
      // session-presence check.
      validateE164(phoneNumber);
      if (callerNumber !== undefined) validateE164(callerNumber);
      throw new NotReadyError(
        `dial requires an active session, currently ${this.getSnapshot().transportState}.`,
      );
    }
    return engine.dial(phoneNumber, callerNumber);
  }

  /** Hand the client a host-owned ``<audio>`` element. Forwarded to every
   *  live session's transport and re-applied on reconnect so the remote
   *  bot audio always lands on the host's element. Pass ``null`` to
   *  detach. Idempotent. The element is client-wide: with several
   *  concurrent sessions, whichever session played audio last owns it —
   *  attach per session via ``session.attachAudioElement`` to isolate
   *  outputs. */
  attachAudioElement(el: HTMLAudioElement | null): void {
    this.hostAudioElement = el;
    for (const record of this.engineRecords) {
      record.engine.attachAudioElement(el);
    }
  }

  /** Register a transport-level RPC method handler the server invokes via
   *  LiveKit ``perform_rpc`` for client-tool execution. Forwarded to the
   *  most recent live session's transport; throws if no session is
   *  connected.
   *
   *  Why this exists: server dispatch goes through ``perform_rpc`` and
   *  drops any ``tool-reply`` data-channel messages, so the browser must
   *  reply via the RPC return value. */
  registerRpcMethod(
    name: string,
    handler: (payload: string) => Promise<string>,
  ): Unsubscribe {
    const engine = this.compatEngine();
    if (engine === null) {
      throw new NotReadyError(
        `registerRpcMethod requires a connected transport, currently ${this.getSnapshot().transportState}.`,
      );
    }
    return engine.registerRpcMethod(name, handler);
  }

  /** Replay all remote audio from a user gesture (the StartAudio affordance)
   *  to clear a browser autoplay block. Forwarded to the active transport;
   *  a no-op when no session is connected. */
  async resumeAudioPlayback(): Promise<void> {
    await this.compatEngine()?.resumeAudioPlayback();
  }

  /** Mark the remote-audio output as blocked (browser refused autoplay)
   *  or unblocked (a user gesture has caused ``play()`` to succeed).
   *  Called by ``<RealtimeAudio />`` from its own ``play``/``pause``
   *  listeners — the SDK's own state machine doesn't observe the audio
   *  element directly, so the React primitive that owns the element is
   *  the source of truth for autoplay status. */
  setOutputBlocked(blocked: boolean): void {
    const engine = this.compatEngine();
    if (engine !== null) {
      engine.setOutputBlocked(blocked);
      return;
    }
    const current = this.cachedSnapshot.mediaState.output;
    const next = blocked
      ? current !== 'blocked'
        ? ('blocked' as const)
        : null
      : current === 'blocked'
        ? ('silent' as const)
        : null;
    if (next === null) return;
    this.cachedSnapshot = {
      ...this.cachedSnapshot,
      mediaState: { ...this.cachedSnapshot.mediaState, output: next },
    };
    this.emitter.emit('media_state', this.cachedSnapshot.mediaState);
  }

  async setMicMuted(muted: boolean): Promise<void> {
    await this.requireEngine('setMicMuted').setMicMuted(muted);
  }

  // ─── Screen share ──────────────────────────────────────────────────────

  isScreenSharing(): boolean {
    return this.compatEngine()?.isScreenSharing() ?? false;
  }

  getScreenShareState(): ScreenShareState {
    return this.compatEngine()?.getScreenShareState() ?? this.cachedSnapshot.mediaState.screen;
  }

  async startScreenShare(): Promise<void> {
    await this.requireEngine('startScreenShare').startScreenShare();
  }

  async stopScreenShare(): Promise<void> {
    await this.compatEngine()?.stopScreenShare();
  }

  /** Snapshot whether fresh frames are flowing into the model's vision
   *  input. Looks across every published video track of the most recent
   *  live session (screen-share AND camera) and picks the most informative
   *  answer the model can act on. Returned shape mirrors the wire output of
   *  the desktop adapter's ``get_current_screen`` tool so the dispatcher can
   *  pass it straight through to the model. */
  getVisionInputStatus(): { captured: boolean; message: string } {
    const engine = this.compatEngine();
    if (engine !== null) return engine.getVisionInputStatus();
    return computeVisionInputStatus([], null);
  }

  // ─── Video streams ────────────────────────────────────────────────────

  async addVideoStream(
    stream: MediaStream,
    options?: VideoStreamOptions,
  ): Promise<VideoStreamHandle> {
    return this.requireEngine('addVideoStream').addVideoStream(stream, options);
  }

  async removeVideoStream(streamId: VideoStreamHandle): Promise<void> {
    await this.compatEngine()?.removeVideoStream(streamId);
  }

  // ─── Audio streams ────────────────────────────────────────────────────

  async startAudioStream(stream: MediaStream): Promise<void> {
    await this.requireEngine('startAudioStream').startAudioStream(stream);
  }

  async stopAudioStream(): Promise<void> {
    await this.compatEngine()?.stopAudioStream();
  }

  /** Resolve when the most recent live session reaches ``transportState ===
   *  'ready'``. Resolves immediately if already ready, rejects if the
   *  session ends (or disconnects) before becoming ready. Use this between
   *  ``await agent.start()`` and the first ``sendText()`` to avoid the
   *  ``NotReadyError`` race. */
  waitUntilReady(): Promise<void> {
    const engine = this.compatEngine();
    if (engine === null) {
      return Promise.reject(
        new NotReadyError('waitUntilReady called with no active connection.'),
      );
    }
    return engine.waitUntilReady();
  }

  setError(error: ErrorEvent | null): void {
    const engine = this.compatEngine();
    if (engine !== null) {
      engine.setError(error);
      // The engine dedupes against its own state; if the aggregated stream
      // still shows a dead session's error, retract it here.
      if (error === null && this.lastEmittedError !== null) this.emitError(null);
      return;
    }
    if (this.cachedSnapshot.error === error && this.lastEmittedError === error) return;
    this.cachedSnapshot = { ...this.cachedSnapshot, error };
    if (error !== null && this.cachedSnapshot.transportState !== 'failed') {
      this.cachedSnapshot = { ...this.cachedSnapshot, transportState: 'failed' };
      this.emitter.emit('transport_state', 'failed');
    }
    this.emitError(error);
  }

  // ─── Internal hatch ────────────────────────────────────────────────────
  //
  // ``_internal`` carries the non-public hatches: raw ``AnalyserNode``
  // subscriptions for waveform UIs and a screen-share flag subscription.
  // Marked ``@internal`` so external consumers know not to depend on it;
  // the public surface is the typed ``on()`` / ``getSnapshot()`` /
  // ``waitUntilReady()`` API. The raw wire-frame feed is session-scoped
  // (each session subscribes to its own engine), so it has no client hatch.
  // Bundled into one object instead of scattered class methods so the
  // published ``RealtimeClient`` type has a narrow, beta-shaped surface.
  // Subscriptions are durable across sessions — the client re-wires them
  // to each new engine.
  /** @internal */
  readonly _internal: RealtimeClientInternal = {
    getInputAnalyser: () => this.compatEngine()?.getInputAnalyser() ?? null,
    getOutputAnalyser: () => this.compatEngine()?.getOutputAnalyser() ?? null,
    subscribeInputAnalyser: (cb) => {
      this.inputAnalyserListeners.add(cb);
      return () => {
        this.inputAnalyserListeners.delete(cb);
      };
    },
    subscribeOutputAnalyser: (cb) => {
      this.outputAnalyserListeners.add(cb);
      return () => {
        this.outputAnalyserListeners.delete(cb);
      };
    },
    subscribeScreenShare: (cb) =>
      this.emitter.on('media_state', (media) => {
        cb(media.screen.kind === 'active');
      }),
  };
}
