/**
 * Transport-agnostic contract for the Cosmo Realtime SDK.
 *
 * The session manager and any other SDK consumer must depend on
 * ``RealtimeTransport`` rather than a concrete adapter (LiveKit, raw
 * WebSocket, future SFUs). The wire shape is still the typed
 * ``Realtime*`` payloads from the generated SDK; only the delivery
 * mechanism varies.
 *
 * Implementations live under ``transport/<name>_transport.ts``. No
 * vendor-specific types may leak through this surface — that's how we
 * keep the public SDK swap-friendly.
 */

import type { SessionConfig } from '../wire/types.gen';
import type { SessionConnectTimings } from '../core/state';

import type {
  RealtimeClientMessage,
  RealtimeInboundMessage,
} from './envelope';

export type Unsubscribe = () => void;

export type RealtimeConnectOptions = {
  /** External-protocol ``session-config`` body the transport POSTs
   *  verbatim to mint the session. Built by the agent mapping
   *  (``buildAgentSessionConfig`` in ``core/agent.ts``); the transport
   *  never inspects it beyond serialization. */
  config: SessionConfig;
  /** Absolute session-start URL the transport POSTs to mint a session. The
   *  SDK composes it from ``RealtimeClientOptions.baseUrl`` (or the page's
   *  own origin for same-origin in-app usage), so the transport itself
   *  holds no Cosmo URL layout — it just POSTs where it's told. */
  sessionStartUrl: string;
  /** Publish the local microphone after joining the room. Defaults to
   *  ``true``. The client passes ``false`` for outbound-phone sessions,
   *  where the browser is a silent observer — a parallel browser mic
   *  track would be mixed into the SIP feed and heard as an echo off the
   *  callee's phone speaker. When ``false`` the transport also skips the
   *  voice-binding frame, so the agent listens to the dialed party. */
  publishMicrophone?: boolean;
  /** Resolve extra request headers (typically Authorization or a custom
   *  workspace header) attached to the session-start POST. Returns sync
   *  or async; ``Content-Type`` is set by the transport and cannot be
   *  overridden. When omitted the transport sends only ``Content-Type``. */
  getAuthHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
  /** Optional callback fired with the server-minted ``session_id``
   *  the instant the session-start POST returns — well before the
   *  realtime model's ``ready`` data-channel message arrives.
   *  Used by the realtime client to publish the id into its state
   *  early so consumers polling per-session endpoints can start
   *  work without waiting on the data channel, which is slow /
   *  unreliable on outbound-phone sessions where the browser never
   *  publishes a track.
   *
   *  Deliberately the id and not the whole start response: a transport
   *  that mints no room (the replay transport) would have to fabricate
   *  join credentials to satisfy the signature, and no caller needs them. */
  onSessionStarted?: (sessionId: string) => void;
  /** Optional callback fired once the connect completes, carrying the
   *  measured phase breakdown. */
  onConnectTimings?: (timings: SessionConnectTimings) => void;
};

export type ScreenShareOptions = {
  /** Capture frame rate. Defaults to a transport-chosen low value
   *  (~1 FPS) suitable for vision input on the receiving model. */
  fps?: number;
  /** Capture resolution. Implementations cap at the requested ceiling
   *  but may downscale based on bandwidth. */
  resolution?: '720p' | '1080p';
  /** Fires once when the underlying capture ends — either because the
   *  user clicked the browser's "Stop sharing" UI or the transport
   *  programmatically unpublished the track. Called at most once. */
  onEnded?: () => void;
};

export type VideoStreamKind = 'camera' | 'screen';

export type VideoStreamHandle = string;

export type VideoStreamOptions = {
  /** Caller-supplied id used to refer to the stream on
   *  ``removeVideoStream``. When omitted the transport returns its own
   *  id (typically the underlying track sid). */
  id?: string;
  /** Capture frame rate ceiling. Defaults to a low value (~1 FPS)
   *  suitable for vision input on the receiving model. */
  fps?: number;
  /** Track source semantics. ``camera`` is the default and covers webcams,
   *  file-backed canvases, and external cameras. ``screen`` signals that
   *  the underlying MediaStream came from ``getDisplayMedia`` so the
   *  transport publishes it as ``Track.Source.ScreenShare``. */
  kind?: VideoStreamKind;
};

export type RealtimeCloseInfo = {
  /** Human-readable disconnect reason, prefixed by the transport
   *  (e.g. ``livekit:CLIENT_INITIATED``). */
  reason?: string;
  /** Optional machine-readable code; transport-defined. */
  code?: string;
};

/** One inbound RPC invocation, narrowed at the transport boundary so SDK
 *  consumers don't import vendor types. */
export type RpcInvocation = {
  /** JSON-encoded args object. */
  payload: string;
  /** Room identity of the invoking participant. */
  callerIdentity: string;
  /** True when the caller is the session's agent participant (the
   *  transport resolves the vendor participant-kind). Client-tool dispatch
   *  uses this as the agent-only caller guard. */
  callerIsAgent: boolean;
};

/** Transport-agnostic interface every realtime adapter implements.
 *
 *  Lifecycle: ``connect`` resolves once media + data channels are open
 *  and the local mic is publishing. ``disconnect`` is idempotent and
 *  always resolves. ``onClose`` fires for unsolicited disconnects;
 *  callers asked-to-end via ``disconnect`` do NOT receive an
 *  ``onClose`` callback for the same teardown.
 */
export interface RealtimeTransport {
  /** Open the session. Rejects on auth failure, mic denial, or
   *  underlying transport failure. On any throw during setup, all
   *  allocations are released so direct callers don't leak. */
  connect(options: RealtimeConnectOptions): Promise<void>;

  /** Tear down the session. Idempotent; safe to call when already
   *  disconnected. ``sendEndFrame: false`` skips the graceful wire ``end``
   *  frame (an abrupt local close). */
  disconnect(opts?: { sendEndFrame?: boolean }): Promise<void>;

  /** Send one logical client message. Implementations are responsible
   *  for any chunking required by their underlying transport. Resolves
   *  once the bytes hit the wire; rejects on publish failure so callers
   *  can avoid emitting optimistic UI before the message is actually
   *  delivered. */
  send(message: RealtimeClientMessage): Promise<void>;

  /** Send a large binary payload to the session's agent on ``topic``,
   *  targeted to the agent participant(s) only — never broadcast to the
   *  room. For payloads too large for the reliable data-channel ``send``
   *  path (~15 KiB), such as a screenshot plus accessibility dump for
   *  grounded screen control. Resolves once the payload is written and the
   *  stream closed; rejects when the transport is not connected or no agent
   *  participant is present to receive it. Optional on the interface so
   *  test fakes can opt out. */
  sendBytes?(data: Uint8Array, topic: string): Promise<void>;

  /** Toggle the local mic track and send the matching ``mute`` data
   *  packet so the agent's VAD respects user intent. */
  setMicMuted(muted: boolean): Promise<void>;

  /** Publish an arbitrary ``MediaStream`` as a video track — webcam,
   *  file-backed canvas, external camera, screen capture, etc. Returns
   *  the stream id that can later be passed to ``removeVideoStream``.
   *  The transport picks the id (typically the underlying track sid)
   *  unless the caller supplies one in ``options.id``. Screen-share
   *  publishes go through here with ``{ kind: 'screen' }`` so the
   *  transport doesn't carry duplicate "screen share" methods alongside
   *  the generic video API.
   *
   *  Optional on the interface so test fakes can opt out — call sites
   *  must null-check or feature-detect before invoking. */
  addVideoStream?(
    stream: MediaStream,
    options?: VideoStreamOptions,
  ): Promise<VideoStreamHandle>;

  /** Unpublish a previously-added video stream. Idempotent — a missing
   *  id is a no-op. Optional on the interface so test fakes can opt
   *  out. */
  removeVideoStream?(streamId: VideoStreamHandle): Promise<void>;

  /** Publish an arbitrary ``MediaStream`` as an audio track — Web Audio
   *  synthesis, a decoded WAV, an ``<audio>`` element's ``captureStream()``,
   *  or a non-default input device.
   *
   *  Publishing audio declares this participant the session's voice
   *  (``bind-input``) and clears the server-side mute gate, so the agent
   *  listens to the track that was just published.
   *
   *  A session carries one voice, so the stream takes it from the device
   *  microphone for its lifetime and ``stopAudioStream`` hands it back. A
   *  second ``startAudioStream`` while one is running throws
   *  ``AudioPublishAlreadyActiveError``.
   *
   *  Optional on the interface so test fakes can opt out — call sites
   *  must null-check or feature-detect before invoking. */
  startAudioStream?(stream: MediaStream): Promise<void>;

  /** Give the voice back to the microphone the stream displaced.
   *  Idempotent. Optional on the interface so test fakes can opt out. */
  stopAudioStream?(): Promise<void>;

  /** Underlying mic media stream. Exposed so callers can build an
   *  ``AnalyserNode`` for the input waveform without re-requesting
   *  mic permission. ``null`` until the session is connected. */
  getInputStream(): MediaStream | null;

  /** Underlying remote audio element. Exposed so callers can side-tap
   *  an ``AnalyserNode`` for the AI-output waveform. ``null`` until
   *  the session is connected. */
  getOutputAudioElement(): HTMLAudioElement | null;

  /** Hand the transport a host-owned ``<audio>`` element. The transport
   *  attaches the remote-bot audio track to this element instead of the
   *  hidden one it would otherwise append to ``document.body``. Pass
   *  ``null`` to detach and fall back to the auto-created element.
   *
   *  Idempotent; calling repeatedly with the same element is a no-op.
   *  Safe to call before or after ``connect``: if a remote track is
   *  already attached to a different element, the transport re-attaches
   *  it to the new one. */
  attachAudioElement(el: HTMLAudioElement | null): void;

  /** Replay all remote audio elements from a user gesture to recover from a
   *  browser autoplay block. Optional: transports without per-element audio
   *  management may omit it. */
  resumeAudioPlayback?(): Promise<void>;

  /** Subscribe to inbound server messages. Returns an unsubscribe
   *  function. Multiple subscribers receive the same message. A packet the
   *  transport could not decode arrives as the undecodable marker rather
   *  than being dropped — decode failure is never terminal. */
  onMessage(cb: (msg: RealtimeInboundMessage) => void): Unsubscribe;

  /** Subscribe to unsolicited close events. Returns an unsubscribe
   *  function. A close caused by the local ``disconnect()`` call does
   *  NOT fire this callback. */
  onClose(cb: (info?: RealtimeCloseInfo) => void): Unsubscribe;

  /** Subscribe to transient transport-level reconnect attempts (ICE
   *  restart, signal-server reconnect). The underlying transport (e.g.
   *  LiveKit) handles the recovery internally — this callback is
   *  informational so the SDK can drive a "Reconnecting…" UI state.
   *  Followed by either ``onReconnected`` (success) or ``onClose``
   *  (failure). */
  onReconnecting(cb: () => void): Unsubscribe;

  /** Subscribe to successful recovery after ``onReconnecting``. */
  onReconnected(cb: () => void): Unsubscribe;

  /** Register an RPC method handler on the local participant so the
   *  server-side RPC bridge can invoke client-side tools.
   *  ``invocation.payload`` is the JSON-encoded args dict; the handler must
   *  return a JSON-encoded ``{ok, result, error}`` envelope per the
   *  backend's RPC bridge contract. Returns an unsubscribe that
   *  unregisters the method.
   *
   *  Callable before ``connect()``: the transport must guarantee every
   *  method registered pre-connect is live before it delivers any inbound
   *  invocation, so a call arriving during the join is handled rather than
   *  rejected as unknown. Optional on the interface so test fakes can opt
   *  out. */
  registerRpcMethod?(
    name: string,
    handler: (invocation: RpcInvocation) => Promise<string>,
  ): Unsubscribe;
}
