import { resolvePlugins } from './plugins';
/**
 * ``RealtimeClient`` — instantiable entry point of the Cosmo Realtime SDK.
 *
 * Owns what outlives any one session: the credential (API key / minted
 * token / host auth), the resolved base URL, and the agent factories.
 * Each ``agent.start()`` creates its own ``SessionEngine`` — transport,
 * state, event stream — so one client runs any number of concurrent
 * sessions, and two clients coexist without tripping over shared state.
 *
 * Everything scoped to one run — events, sends, media controls,
 * lifecycle — lives on the ``RealtimeSession`` that ``agent.start()``
 * returns.
 */

import { SDK_NAME, SDK_VERSION } from '../constants';
import type { SessionConfig } from '../protocol';

import {
  RealtimeAgent,
  type AgentConfig,
  type CatalogAgentOptions,
  type BackgroundClientTool,
  type ClientTool,
  type SessionStartOptions,
} from './agent';
import type { ScreenLocateTool } from './agent';
import type { HookEngine } from './hooks';
import { log } from './logger';

import { LiveKitTransport } from '../transport/livekit_transport';
import { unsupportedTransportCapability } from '../transport/session_start_error';
import { WebSocketTransport } from '../transport/websocket_transport';
import type { PreparedRoomRef } from '../transport/prepared_room';
import type { RealtimeTransport } from '../transport/types';
import {
  assertSupportedBaseUrl,
  composeDialUrl,
  composeMintTokenUrl,
  composePrepareRoomUrl,
  composeStartUrl,
  composeWebSocketStartUrl,
  composeUsageUrl,
  composeVerifyUrl,
} from '../transport/external_session_url';
import { assertNotApiKeyInTokenSlot, cleanCredential } from './credential_guard';
import { resolveCredentialFromRuntime } from './credentials_file';
import { getVerify, type CredentialInfo } from './verify';
import { getUsage, type SessionUsage } from './usage';
import {
  postMintToken,
  CredentialsError,
  MintTokenError,
  type MintedToken,
} from './auth';
import { resolveBaseUrl } from './base_url';
import { TokenSource } from './token_source';
import { SessionEngine } from './session_engine';
import { RealtimeSession } from './session';
import type { Unsubscribe } from './events';

/** How a ``RealtimeClient`` is configured: its credential, and how its
 *  sessions travel. Every field is optional — a client constructed with none
 *  resolves a credential from the environment. */
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
  /** How session media travels. ``webrtc`` is the managed/default lane;
   *  ``websocket`` is the single-socket lane served by a local OSS server.
   *  ``livekit`` is a deprecated alias of ``webrtc``. */
  transport?: TransportName;
  /** Factory used to construct the underlying ``RealtimeTransport`` per
   *  session start. Defaults to ``LiveKitTransport``. */
  transportFactory?: () => RealtimeTransport;
};

/** How session media travels. ``webrtc`` is the default managed lane;
 *  ``websocket`` is the single-socket lane served by a local OSS server.
 *  ``livekit`` is a deprecated alias of ``webrtc``. */
type TransportName = 'webrtc' | 'websocket' | 'livekit';
type ResolvedTransportName = 'webrtc' | 'websocket';

/**
 * Entry point of the SDK — construct one, then build agents from it.
 *
 * ```ts
 * const client = new RealtimeClient({ apiKey });
 * const session = await client.agent({ instructions: 'Be brief.' }).start();
 * ```
 *
 * The client owns what outlives any one session: the credential, the
 * resolved base URL, and the agent factories. It also carries the
 * credential-scoped calls that are not about a single run — ``verify()``,
 * ``mintToken()``, ``getSessionUsage()``.
 *
 * Each ``agent.start()`` opens an independent session, so one client can run
 * any number of them concurrently. Everything scoped to one run — events,
 * sends, media controls, ending — lives on the ``RealtimeSession`` that
 * ``start()`` returns.
 */
export class RealtimeClient {
  private readonly options: Omit<
    RealtimeClientOptions,
    'apiKey' | 'token' | 'transport'
  >;
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
  readonly #transportName: ResolvedTransportName;

  /** The Cosmo API origin this client talks to. Resolved at construction;
   *  a zero-argument client whose key came from the ``cosmo login``
   *  credentials file adopts the profile's ``base_url`` at first use. */
  get baseUrl(): string {
    return this.#baseUrl;
  }

  constructor(options: RealtimeClientOptions = {}) {
    const { apiKey: rawApiKey, token: rawToken, transport, ...rest } = options;
    if (rawApiKey !== undefined && rawToken !== undefined) {
      throw new CredentialsError({
        code: 'conflicting_credentials',
        message: 'Provide at most one of apiKey or token, not both.',
      });
    }
    if (transport !== undefined && rest.transportFactory !== undefined) {
      throw new Error('Provide transport or transportFactory, not both.');
    }
    // Clean before the guard below reads the value. A key pasted with a
    // byte-order mark does not match the ``cosmo_`` prefix until it is
    // cleaned, so guarding first would pass it and then clean it into a
    // working bearer credential — the exact value that guard refuses.
    const apiKey = rawApiKey === undefined ? undefined : cleanCredential(rawApiKey);
    const token = typeof rawToken === 'string' ? cleanCredential(rawToken) : rawToken;
    if (typeof token === 'string') {
      assertNotApiKeyInTokenSlot(token);
    }
    this.#tokenSource = token instanceof TokenSource ? token : null;
    this.#credential = apiKey ?? (typeof token === 'string' ? token : null);
    this.#canMint = apiKey !== undefined;
    this.#needsCredentialResolution =
      apiKey === undefined && token === undefined && rest.getAuthHeaders === undefined;
    this.#baseUrl = resolveBaseUrl();
    this.#transportName =
      rest.transportFactory === undefined ? resolveTransportName(transport) : 'webrtc';
    this.options = rest;
  }

  /** @internal — whether sessions from this client run in rooms the
   *  backend can reserve ahead of a start (the default ``webrtc`` lane). */
  get _canPrepareRooms(): boolean {
    return this.#transportName === 'webrtc' && this.options.transportFactory === undefined;
  }

  /** @internal — ``POST session/prepare-room``, the reservation behind
   *  ``agent.prepareSession()``. Best-effort by design: a failure logs and
   *  resolves ``null``, leaving the start on the ordinary path. */
  async _prepareRoom(): Promise<PreparedRoomRef | null> {
    try {
      // Credential resolution can move ``baseUrl``; the reservation must
      // land on the backend the start will use.
      await this.#ensureCredentialResolved();
      const headers = {
        ...(await this.resolveAuthHeaders()),
        'Content-Type': 'application/json',
      };
      // Bounded like the Python SDK's reservation: a prepared start awaits
      // this, and an accelerator must never hang the start it accelerates.
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), PREPARE_ROOM_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(composePrepareRoomUrl(this.#baseUrl), {
          method: 'POST',
          headers,
          body: '{}',
          signal: abort.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) {
        log.debug(`[realtime] prepare-room rejected (${response.status})`);
        return null;
      }
      const body = (await response.json()) as {
        livekit_url: string;
        token: string;
        room_name: string;
        room_grant: string;
      };
      return {
        roomName: body.room_name,
        roomGrant: body.room_grant,
        token: body.token,
        livekitUrl: body.livekit_url,
        preparedAt: Date.now(),
      };
    } catch (err) {
      log.debug('[realtime] prepare-room failed', err);
      return null;
    }
  }

  /** Run the zero-argument resolution chain (``COSMO_API_KEY``, then the
   *  ``cosmo login`` credentials file) exactly once, before the first
   *  request. With nothing to resolve it throws ``CredentialsError``
   *  (``no_credential``) — the first authenticated call fails before any
   *  request goes out, the outcome the Python and Swift constructors
   *  produce. A file credential brings its own ``base_url``, so this must
   *  complete before any URL is composed. */
  async #ensureCredentialResolved(): Promise<void> {
    if (!this.#needsCredentialResolution) return;
    this.#credentialResolution ??= (async () => {
      const resolved = await resolveCredentialFromRuntime();
      // Same cleaning as a key passed to the constructor: this one came out
      // of an environment variable or the credentials file, which is where
      // a stray newline or byte-order mark is most likely to be attached.
      this.#credential = cleanCredential(resolved.apiKey);
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
   *  Takes an explicit session id because the client outlives any one
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
   *  ``options.ttlSeconds`` (60–86400) shortens the 24-hour default lifetime.
   *
   *  Throws ``MintTokenError`` if this client has no ``apiKey`` (a
   *  token- or cookie-credentialed client cannot mint) or the server rejects
   *  it. */
  async mintToken(
    externalUserId: string,
    options: { ttlSeconds?: number } = {},
  ): Promise<MintedToken> {
    await this.#ensureCredentialResolved();
    if (!this.#canMint) {
      throw new MintTokenError({
        code: 'missing_api_key',
        message:
        'mintToken requires an apiKey credential — pass apiKey, set ' +
          'COSMO_API_KEY, or sign in with `cosmo login`. A minted token cannot mint.',
      });
    }
    return postMintToken({
      mintUrl: composeMintTokenUrl(this.baseUrl),
      externalUserId,
      ttlSeconds: options.ttlSeconds,
      getAuthHeaders: () => this.resolveAuthHeaders(),
    });
  }

  /** Build a reusable persona — immutable; open runs with
   *  ``agent.start()``. Fields left unset fall through to the server-side
   *  protocol defaults. */
  agent(config: AgentConfig = {}): RealtimeAgent {
    return new RealtimeAgent(this, resolvePlugins(config));
  }

  /** Build an agent that runs a workspace catalog agent by machine handle;
   *  the stored config runs verbatim. Only per-run ride-alongs are
   *  accepted (``CatalogAgentOptions``) — no persona parameters except
   *  ``voice``, the one cosmetic override; anything else stored-config is a
   *  type error. */
  catalogAgent(name: string, options: CatalogAgentOptions = {}): RealtimeAgent {
    return new RealtimeAgent(this, {
      name,
      inputs: options.inputs,
      tools: options.tools,
      voice: options.voice,
      hooks: options.hooks,
    });
  }

  private createEngine(): SessionEngine {
    return new SessionEngine({
      createTransport: () =>
        this.options.transportFactory
          ? this.options.transportFactory()
          : this.#transportName === 'websocket'
            ? new WebSocketTransport()
            : new LiveKitTransport(),
      startUrl: () =>
        this.#transportName === 'websocket'
          ? composeWebSocketStartUrl(this.baseUrl)
          : composeStartUrl(this.baseUrl),
      dialUrl: (sessionId) => composeDialUrl(this.baseUrl, sessionId),
      usageUrl: (sessionId) => composeUsageUrl(this.baseUrl, sessionId),
      resolveAuthHeaders: () => this.resolveAuthHeaders(),
      onStartUnauthorized: () => {
        // The fetched token was rejected despite the refresh skew (revoked,
        // or clocks disagree): drop it so the next start fetches fresh.
        this.#tokenSource?._invalidate();
      },
    });
  }

  /** @internal — the session factory behind ``RealtimeAgent.start()`` and
   *  ``PreparedSession.start()``: creates a fresh engine per call, so
   *  concurrent starts yield independent sessions. Takes the prebuilt
   *  external ``session-config`` body and, on the prepared path, the
   *  reserved room; the public way to open a session is
   *  ``client.agent({...}).start()``. */
  async _startSession(options: {
    config: SessionConfig;
    publishMicrophone: boolean;
    onStateChange?: SessionStartOptions['onStateChange'];
    onSession?: SessionStartOptions['onSession'];
    clientTools?: readonly (ClientTool | BackgroundClientTool)[];
    screenLocate?: ScreenLocateTool;
    hooks?: HookEngine;
    prepared?: PreparedRoomRef;
    connectStartedAt?: number;
  }): Promise<RealtimeSession> {
    if (
      this.#transportName === 'websocket' &&
      options.clientTools?.some((tool) => tool.background === true)
    ) {
      throw unsupportedTransportCapability(
        'background_tools_unsupported',
        'Background client tools are not supported by the websocket transport.',
      );
    }
    // Credential resolution runs before the engine starts — a file
    // credential can move ``baseUrl``, and the engine composes its
    // session-start URL from it.
    await this.#ensureCredentialResolved();
    const engine = this.createEngine();
    // Subscribed before the connect begins, so the caller observes the
    // full state prefix from ``idle`` (``engine.on`` replays the current
    // state at subscribe time).
    let stateUnsub: Unsubscribe | null = null;
    if (options.onStateChange !== undefined) {
      stateUnsub = engine.on('lifecycle', options.onStateChange);
    }
    const session = new RealtimeSession(engine, stateUnsub);
    // Before the connect: a caller wiring callbacks here sees every event
    // the connect itself produces.
    options.onSession?.(session);
    try {
      await engine.start(options);
    } catch (err) {
      stateUnsub?.();
      throw err;
    }
    return session;
  }
}

const PREPARE_ROOM_TIMEOUT_MS = 40_000;

function resolveTransportName(given: TransportName | undefined): ResolvedTransportName {
  const fromEnvironment =
    typeof process === 'undefined' ? undefined : process.env?.COSMO_TRANSPORT;
  const environmentName = fromEnvironment?.trim().toLowerCase();
  const name = (given ?? environmentName) || 'webrtc';
  if (name !== 'webrtc' && name !== 'websocket' && name !== 'livekit') {
    throw new Error(`transport must be webrtc or websocket, got ${JSON.stringify(name)}`);
  }
  if (name === 'livekit') {
    log.warn('[realtime] transport "livekit" is deprecated; use "webrtc"');
    return 'webrtc';
  }
  return name;
}
