/**
 * LiveKit implementation of ``RealtimeTransport``.
 *
 * Replaces the prior raw-WebRTC + DataChannel setup. Connection flow:
 *
 *   1. POST the external ``session-config`` body to the session-start URL
 *      (``Authorization`` / auth headers from the client) — returns
 *      `{livekit_url, token, room_name, session_id}`.
 *   2. `Room.connect(livekit_url, token)` — LiveKit handles SDP, ICE,
 *      Opus, reconnects.
 *   3. `setMicrophoneEnabled(true)` — publishes the mic as an audio track —
 *      then a ``bind-input`` frame declares this participant the session's
 *      voice (re-asserted on reconnect; the server pin is sticky).
 *   4. `TrackSubscribed` for the agent's audio track → `track.attach(audio)`.
 *      Chromium's AEC reference signal includes remote LiveKit tracks
 *      attached to ``<audio>`` elements natively — no loopback hacks.
 *   5. `publishData(jsonBytes, {reliable: true})` — external-protocol JSON
 *      wire messages over the data channel. FE switches on the
 *      `type` discriminator in `DataReceived`.
 *
 * The orchestrator on the server joins the same room under identity
 * ``agent:<session_id>``; the human is ``user:<user_id>``.
 *
 * LiveKit-specific types MUST stay inside this file. The SDK boundary
 * is ``RealtimeTransport`` in ``./types.ts``.
 */

import { AudioPublishAlreadyActiveError } from '../core/errors';
import { log } from '../core/logger';
import {
  ConnectionState,
  DisconnectReason,
  LocalAudioTrack,
  LocalVideoTrack,
  type LocalTrackPublication,
  ParticipantKind,
  RemoteTrack,
  Room,
  RoomEvent,
  Track,
} from 'livekit-client';

import {
  buildOutboundPackets,
  decodeInbound,
  EnvelopeReassembler,
  type RealtimeClientMessage,
  type RealtimeInboundMessage,
} from './envelope';
import type {
  RealtimeCloseInfo,
  RealtimeConnectOptions,
  RealtimeTransport,
  RpcInvocation,
  Unsubscribe,
  VideoStreamHandle,
  VideoStreamOptions,
} from './types';
import {
  SessionStartTransportError,
  parseRetryAfter,
  parseSessionStartErrorDetail,
  sessionStartErrorFrom,
} from './session_start_error';
import { describeFetchFailure } from './fetch_failure';
import type { SessionResponse } from '../wire/types.gen';
import type { SessionConnectTimings } from '../core/state';

function isLkTestStub(): boolean {
  return typeof window !== 'undefined' &&
    (window as unknown as Record<string, unknown>).__LK_TEST_STUB__ === true;
}

const ROOM_OPTIONS = {
  adaptiveStream: true,
  dynacast: true,
  audioCaptureDefaults: {
    // Echo cancellation stays on so the speaker→mic loop doesn't feed the
    // agent its own voice. Noise suppression and auto gain control are
    // deliberately off: on laptop speakers they continuously duck the user's
    // mic during double-talk, dropping their speech below the agent VAD's
    // speech-start threshold so barge-ins stop working. AEC alone leaves the
    // user's level intact while still removing the agent's echo.
    echoCancellation: true,
    noiseSuppression: false,
    autoGainControl: false,
  },
} as const;

export class LiveKitConnectTimeoutError extends Error {
  readonly name = 'LiveKitConnectTimeoutError';
}

export class LiveKitTransport implements RealtimeTransport {
  private room: Room | null = null;
  private connectTimings: SessionConnectTimings | null = null;
  /** The element the remote bot audio track is currently attached to.
   *  Equal to ``hostAudioElement`` when a host has called
   *  ``attachAudioElement``; otherwise the auto-created hidden element. */
  private audioElement: HTMLAudioElement | null = null;
  /** Host-supplied element via ``attachAudioElement``. Not owned by the
   *  transport — we never remove it from the DOM on teardown. */
  private hostAudioElement: HTMLAudioElement | null = null;
  /** The track currently attached to ``audioElement`` (the host element).
   *  Held so we can re-attach to a new element if ``attachAudioElement`` is
   *  called after the ``TrackSubscribed`` event has already fired. */
  private primaryAudioTrack: RemoteTrack | null = null;
  /** Additional simultaneously-subscribed remote audio tracks, each on its
   *  OWN hidden ``<audio>`` element. A LiveKit room can carry several
   *  remote audio tracks a participant must hear at once — e.g. on an
   *  outbound phone call the browser hears the agent and the dialed SIP
   *  participant together. One element per track is the LiveKit-recommended
   *  pattern; a single shared element can only play one track at a time. */
  private extraAudioElements = new Map<RemoteTrack, HTMLAudioElement>();
  private isClosingByUs = false;
  /** True once this client published its mic and declared itself the
   *  session's voice — reconnects re-send ``bind-input`` while set. */
  private voiceBound = false;
  private reassembler = new EnvelopeReassembler();
  /** RPC methods registered before the room exists, bound onto the room in
   *  ``_connectInner`` BEFORE ``room.connect`` — livekit-client keeps the
   *  handler registry on the (pre-connect) local participant, so a method
   *  bound pre-join is live for an invocation arriving in the join window. */
  private pendingRpcMethods = new Map<
    string,
    (invocation: RpcInvocation) => Promise<string>
  >();
  private messageListeners = new Set<(msg: RealtimeInboundMessage) => void>();
  private closeListeners = new Set<(info?: RealtimeCloseInfo) => void>();
  private reconnectingListeners = new Set<() => void>();
  private reconnectedListeners = new Set<() => void>();
  private videoStreams = new Map<string, LocalTrackPublication>();
  private videoStreamSeq = 0;
  /** The session's one caller-owned audio publish, and the microphone it
   *  displaced so removal can hand the voice back. */
  private audioStream: {
    pub: LocalTrackPublication;
    displacedMic: LocalAudioTrack | null;
  } | null = null;

  async connect(options: RealtimeConnectOptions): Promise<void> {
    if (this.room) return;
    try {
      await this._connectInner(options);
    } catch (err) {
      await this.disconnect();
      throw err;
    }
  }

  private async _connectInner(options: RealtimeConnectOptions): Promise<void> {
    // Reuse across reconnect: a previous disconnect set isClosingByUs=true
    // so the matching ``onClose`` was suppressed; clear it now so the
    // NEW session's unsolicited disconnects fire onClose listeners.
    this.isClosingByUs = false;
    const startedAt = performance.now();
    const session = await this._startSession(options);
    const wsDoneAt = performance.now();
    if (options.onSessionStarted) {
      try {
        options.onSessionStarted(session.session_id);
      } catch (err) {
        log.error('[livekit-transport] onSessionStarted callback threw', err);
      }
    }

    const room = new Room(ROOM_OPTIONS);
    this.room = room;

    // Use the host-supplied <audio> element if a consumer called
    // attachAudioElement before connect (the React <RealtimeAudio/>
    // primitive does so on mount). Otherwise fall back to a hidden
    // element we own + clean up ourselves on disconnect.
    this.audioElement = this.hostAudioElement ?? this.createFallbackAudioElement();

    this._wireRoomEvents(room);
    // Bind every pre-connect RPC registration before the join so a tool
    // invocation arriving the instant the room connects finds its handler.
    for (const [name, handler] of this.pendingRpcMethods) {
      this.bindRpcMethodToRoom(room, name, handler);
    }
    this.pendingRpcMethods.clear();

    // Bound the SDP / ICE phase so a hung LiveKit edge never silently
    // leaves the UI in `requesting_mic` forever.
    await Promise.race([
      room.connect(session.livekit_url, session.token),
      new Promise<never>((_resolve, reject) => {
        setTimeout(
          () => reject(new LiveKitConnectTimeoutError('LiveKit room connect timed out')),
          15000,
        );
      }),
    ]);
    const roomDoneAt = performance.now();
    // Skip mic acquisition entirely when the client asked not to publish
    // (outbound phone dials). The SIP participant is the audio source;
    // publishing the browser mic adds a parallel track that the LiveKit
    // room mixes into the SIP feed, which the user then hears as an echo
    // off their phone speaker. A post-ready auto-mute isn't enough —
    // by the time it fires the mic has already been publishing for
    // the warm-up window.
    const publishesMic = options.publishMicrophone !== false;
    if (publishesMic) {
      await room.localParticipant.setMicrophoneEnabled(true);
      // Declare this participant the session's voice. Best-effort: the
      // server auto-links the sole non-agent participant until a bind
      // arrives, so a lost frame degrades gracefully — but keep the
      // intent latched so a reconnect re-asserts it.
      this.voiceBound = true;
      await this.sendBindInput();
    }
    // Recorded after the mic publish so ``total`` spans the whole connect; a
    // no-publish session (outbound dial) reports ``micMs: 0`` rather than
    // shortening the total.
    const connectReadyAt = performance.now();
    this.connectTimings = {
      wsMs: wsDoneAt - startedAt,
      roomMs: roomDoneAt - wsDoneAt,
      micMs: publishesMic ? connectReadyAt - roomDoneAt : 0,
      totalConnectMs: connectReadyAt - startedAt,
      serverTimings: session.timings ?? null,
    };
    options.onConnectTimings?.(this.connectTimings);
  }

  /** Send the ``bind-input`` voice-binding frame; failures are logged,
   *  never thrown — ``voiceBound`` stays latched so the reconnect
   *  re-assert still fires. */
  private async sendBindInput(): Promise<void> {
    try {
      await this.send({ type: 'bind-input' });
    } catch (err) {
      log.warn('[livekit-transport] bind-input send failed', err);
    }
  }

  private _wireRoomEvents(room: Room): void {
    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
      if (track.kind !== Track.Kind.Audio) return;
      // First remote audio track plays on the host element (the gestured,
      // already-unblocked ``<audio>`` that <RealtimeAudio/> owns, also used
      // for the output analyser + AEC reference). Each additional track gets
      // its own element so simultaneous remote speakers are all audible.
      if (this.primaryAudioTrack === null) {
        this.attachRemoteAudio(track);
      } else {
        this.attachExtraAudio(track);
      }
    });
    room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
      if (track.kind !== Track.Kind.Audio) return;
      const extra = this.extraAudioElements.get(track);
      if (extra) {
        this.removeExtraAudio(track, extra);
        return;
      }
      if (this.primaryAudioTrack !== track) return;
      // The host-element track left. Detach it and promote a remaining
      // extra track onto the host element so the analyser/AEC tap keeps a
      // live source; otherwise clear the slot.
      try { track.detach(); } catch { /* ignore */ }
      const next = [...this.extraAudioElements.keys()][0] ?? null;
      if (next) {
        const nextEl = this.extraAudioElements.get(next);
        if (nextEl) this.removeExtraAudio(next, nextEl);
        this.attachRemoteAudio(next);
      } else {
        this.primaryAudioTrack = null;
      }
    });
    room.on(RoomEvent.DataReceived, (payload, participant, _kind, _topic) => {
      // Protocol frames come only from the agent; drop a room peer's packets
      // (a SIP leg, another client). ``participant`` is undefined for
      // server-API data, which no peer can forge — let it through.
      if (participant !== undefined && !this.isAgentParticipant(participant.identity)) {
        log.warn('[realtime] data frame from non-agent participant dropped', {
          senderIdentity: participant.identity,
        });
        return;
      }
      this.handleDataReceived(payload);
    });
    room.on(RoomEvent.Disconnected, (reason) => {
      if (this.isClosingByUs) return;
      const name =
        reason !== undefined ? DisconnectReason[reason] ?? reason : 'disconnected';
      this.emitClose({ reason: `livekit:${name}` });
    });
    room.on(RoomEvent.Reconnecting, () => {
      for (const cb of this.reconnectingListeners) cb();
    });
    room.on(RoomEvent.Reconnected, () => {
      // Re-assert the voice binding — the server pin is sticky but a
      // room recovery may have rebuilt participant state.
      if (this.voiceBound) void this.sendBindInput();
      for (const cb of this.reconnectedListeners) cb();
    });
  }

  async send(message: RealtimeClientMessage): Promise<void> {
    const room = this.room;
    const type = message.type ?? 'unknown';
    if (!room || room.state !== ConnectionState.Connected) {
      throw new Error(`Realtime transport not connected — dropped ${type}.`);
    }
    const { packets, envelopeId } = buildOutboundPackets(message);
    if (packets.length === 0) {
      throw new Error(
        `Oversized realtime envelope chunk dropped (type=${type}) — refusing to nest.`,
      );
    }
    if (envelopeId !== null) {
      log.info('[livekit-transport] chunking oversized message', {
        type,
        chunks: packets.length,
      });
    }
    // Sequential publish keeps chunk ordering deterministic; reassembly
    // tolerates out-of-order delivery but ordered emission keeps the
    // happy path traceable in logs.
    for (const packet of packets) {
      await room.localParticipant.publishData(packet, { reliable: true });
    }
  }

  async sendBytes(data: Uint8Array, topic: string): Promise<void> {
    const room = this.room;
    if (!room) {
      throw new Error(`Realtime transport not connected — dropped byte stream on ${topic}.`);
    }
    // A byte stream needs explicit destinations; target the agent(s) only so
    // the payload is never fanned out to other room participants.
    const agentIdentities = [...room.remoteParticipants.values()]
      .filter((p) => p.kind === ParticipantKind.AGENT)
      .map((p) => p.identity);
    if (agentIdentities.length === 0) {
      throw new Error(`No agent participant to receive bytes on ${topic}.`);
    }
    const writer = await room.localParticipant.streamBytes({
      topic,
      destinationIdentities: agentIdentities,
    });
    try {
      await writer.write(data);
    } finally {
      await writer.close();
    }
  }

  async setMicMuted(muted: boolean): Promise<void> {
    if (isLkTestStub()) return;
    if (!this.room) return;
    if (muted) {
      await this.room.localParticipant.setMicrophoneEnabled(false);
    } else {
      // Re-enabling the mic: the server-side publish grant may not have
      // propagated to this client yet, so a publish can be briefly
      // rejected. Retry for a short window before surfacing it.
      await this._enableMicrophoneWithRetry();
    }
    await this.send({ type: 'mute', muted });
  }

  private async _enableMicrophoneWithRetry(): Promise<void> {
    const room = this.room;
    if (!room) return;
    let lastError: unknown;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        await room.localParticipant.setMicrophoneEnabled(true);
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
    throw lastError;
  }

  async addVideoStream(
    stream: MediaStream,
    options?: VideoStreamOptions,
  ): Promise<VideoStreamHandle> {
    const room = this.room;
    if (!room) throw new Error('Cannot add video stream — no active session.');
    const [mediaTrack] = stream.getVideoTracks();
    if (!mediaTrack) {
      throw new Error('Video stream must contain at least one video track.');
    }
    const localTrack = new LocalVideoTrack(mediaTrack);
    const fps = options?.fps ?? 1;
    const kind = options?.kind ?? 'camera';
    const source = kind === 'screen' ? Track.Source.ScreenShare : Track.Source.Camera;
    if (kind === 'screen') {
      // Recordings + model vision read on-screen text; 'detail' keeps the
      // encoder at full resolution under bitrate pressure.
      mediaTrack.contentHint = 'detail';
    }
    const desiredName = options?.id ?? `video-${this.videoStreamSeq++}`;
    const pub = await room.localParticipant.publishTrack(localTrack, {
      name: desiredName,
      source,
      videoEncoding: { maxFramerate: fps, maxBitrate: 3_000_000 },
      // livekit-client reads `screenShareEncoding`, not `videoEncoding`, for
      // ScreenShare-source tracks.
      screenShareEncoding: { maxFramerate: fps, maxBitrate: 3_000_000 },
      simulcast: false,
    });
    const streamId = options?.id ?? pub.trackSid ?? desiredName;
    this.videoStreams.set(streamId, pub);
    return streamId;
  }

  async startAudioStream(stream: MediaStream): Promise<void> {
    const room = this.room;
    if (!room) throw new Error('Cannot add audio stream — no active session.');
    if (this.audioStream) {
      throw new AudioPublishAlreadyActiveError(
        'An audio stream is already running — a session carries one voice. ' +
          'Call stopAudioStream before starting another.',
      );
    }
    const [mediaTrack] = stream.getAudioTracks();
    if (!mediaTrack) {
      throw new Error('Audio stream must contain at least one audio track.');
    }
    // The agent's ear pins to a participant and reads its microphone source,
    // so the stream publishes under that source to be heard at all — and the
    // real microphone steps aside, or the room carries two tracks claiming to
    // be the one voice and which one the agent hears (and which one
    // setMicMuted and getInputStream act on) is arbitrary.
    //
    // Unpublished WITHOUT stopping: removal republishes this same still-open
    // track, so the microphone never goes through the open→stop→reopen cycle
    // that yields a silent track on macOS.
    const micPublication = room.localParticipant.getTrackPublication(Track.Source.Microphone);
    const displacedMic = (micPublication?.track as LocalAudioTrack | undefined) ?? null;
    if (displacedMic) {
      await room.localParticipant.unpublishTrack(displacedMic, false);
    }

    let pub: LocalTrackPublication;
    try {
      pub = await room.localParticipant.publishTrack(new LocalAudioTrack(mediaTrack), {
        name: 'audio-stream',
        source: Track.Source.Microphone,
      });
    } catch (err) {
      // The microphone is already unpublished at this point and nothing is
      // tracking it, so a throw here would strand the session voiceless with
      // no handle to recover — and this publish really does get rejected: the
      // server-side grant may not have propagated yet, the same window
      // ``_enableMicrophoneWithRetry`` covers. Put the microphone back
      // before rethrowing.
      if (displacedMic) {
        try {
          await room.localParticipant.publishTrack(displacedMic, {
            source: Track.Source.Microphone,
          });
        } catch (restoreErr) {
          log.error('[livekit-transport] restoring the microphone failed', restoreErr);
        }
      }
      throw err;
    }
    this.audioStream = { pub, displacedMic };
    this.voiceBound = true;
    await this.sendBindInput();
    // Best-effort like the bind: the track is already publishing, so a lost
    // packet must not report the publish as failed. The server gate reopens
    // on the next setMicMuted(false) or reconnect re-assert.
    try {
      await this.send({ type: 'mute', muted: false });
    } catch (err) {
      log.warn('[livekit-transport] unmute packet failed after audio publish', err);
    }
  }

  async stopAudioStream(): Promise<void> {
    const room = this.room;
    const active = this.audioStream;
    if (!active) return;
    this.audioStream = null;
    const track = active.pub.track;
    if (!room) return;
    try {
      if (track) await room.localParticipant.unpublishTrack(track, true);
    } catch (err) {
      log.error('[livekit-transport] stopAudioStream failed', err);
    }
    // Hand the voice back to the microphone the stream displaced. The same
    // track object it was unpublished with, never a fresh capture.
    if (active.displacedMic) {
      try {
        await room.localParticipant.publishTrack(active.displacedMic, {
          source: Track.Source.Microphone,
        });
      } catch (err) {
        log.error('[livekit-transport] restoring the microphone failed', err);
      }
    }
  }

  async removeVideoStream(streamId: VideoStreamHandle): Promise<void> {
    const room = this.room;
    const pub = this.videoStreams.get(streamId);
    if (!pub) return;
    this.videoStreams.delete(streamId);
    const track = pub.track;
    if (!room || !track) return;
    try {
      await room.localParticipant.unpublishTrack(track, true);
    } catch (err) {
      log.error('[livekit-transport] removeVideoStream failed', { streamId }, err);
    }
  }

  async disconnect(opts?: { sendEndFrame?: boolean }): Promise<void> {
    if (!this.room && !this.audioElement) return;
    this.isClosingByUs = true;
    this.voiceBound = false;
    // The end frame is a graceful-shutdown courtesy to the worker; when the
    // server already ended the session (room deleted), the transport is
    // disconnected and there is nothing left to end.
    if (opts?.sendEndFrame !== false && this.room?.state === ConnectionState.Connected) {
      try {
        await this.send({ type: 'end' });
      } catch (err) {
        log.error('[livekit-transport] error sending end frame', err);
      }
    }
    const room = this.room;
    this.room = null;
    if (room) {
      try {
        await room.disconnect();
      } catch (err) {
        log.error('[livekit-transport] disconnect failed', err);
      }
    }
    if (this.primaryAudioTrack) {
      try { this.primaryAudioTrack.detach(); } catch { /* ignore */ }
      this.primaryAudioTrack = null;
    }
    for (const [track, el] of this.extraAudioElements) {
      this.removeExtraAudio(track, el);
    }
    if (this.audioElement) {
      try {
        this.audioElement.pause();
        this.audioElement.srcObject = null;
        // Only remove the element from the DOM if WE created it. A
        // host-supplied element belongs to the React tree that mounted
        // <RealtimeAudio /> — yanking it out would break re-renders.
        if (this.audioElement !== this.hostAudioElement) {
          this.audioElement.remove();
        }
      } catch (err) {
        log.warn('[livekit-transport] audio element teardown failed', err);
      }
      this.audioElement = null;
    }
    this.videoStreams.clear();
    this.audioStream = null;
    this.reassembler.clear();
    this.pendingRpcMethods.clear();
  }

  getInputStream(): MediaStream | null {
    const room = this.room;
    if (!room) return null;
    const mic = room.localParticipant.getTrackPublication(Track.Source.Microphone);
    const track = mic?.track;
    if (!track?.mediaStreamTrack) return null;
    return new MediaStream([track.mediaStreamTrack]);
  }

  getOutputAudioElement(): HTMLAudioElement | null {
    return this.audioElement;
  }

  attachAudioElement(el: HTMLAudioElement | null): void {
    if (this.hostAudioElement === el) return;
    const previous = this.audioElement;
    const previousWasFallback =
      previous !== null && previous !== this.hostAudioElement;
    this.hostAudioElement = el;

    if (el === null) {
      // Detaching: if a session is live we need *some* element to keep
      // playing audio, so spin up the fallback. Otherwise leave null.
      if (this.room && this.primaryAudioTrack) {
        this.audioElement = this.createFallbackAudioElement();
        this.attachRemoteAudio(this.primaryAudioTrack);
      } else {
        this.audioElement = null;
      }
      return;
    }

    this.audioElement = el;
    if (this.primaryAudioTrack) this.attachRemoteAudio(this.primaryAudioTrack);
    if (previousWasFallback && previous) {
      try {
        previous.pause();
        previous.srcObject = null;
        previous.remove();
      } catch (err) {
        log.warn('[livekit-transport] fallback cleanup failed', err);
      }
    }
  }

  /** Attach a remote audio track to the host element (LiveKit manages the
   *  element's srcObject + autoplay/start-audio state). */
  private attachRemoteAudio(track: RemoteTrack): void {
    this.primaryAudioTrack = track;
    if (!this.audioElement) return;
    try {
      track.attach(this.audioElement);
    } catch (err) {
      log.warn('[livekit-transport] remote audio attach failed', err);
    }
  }

  /** Attach a simultaneously-active remote audio track to its own hidden
   *  element. During a live call the page already has a gestured, playing
   *  element so a freshly-created one usually inherits that activation;
   *  ``resumeAudioPlayback`` (wired to the StartAudio gesture) recovers any
   *  that the browser still blocks. */
  private attachExtraAudio(track: RemoteTrack): void {
    const el = this.createFallbackAudioElement();
    this.extraAudioElements.set(track, el);
    try {
      track.attach(el);
    } catch (err) {
      log.warn('[livekit-transport] extra audio attach failed', err);
    }
    const result = el.play();
    if (result !== undefined) {
      result.catch((err) => {
        log.warn('[livekit-transport] extra audio autoplay blocked', err);
      });
    }
  }

  private removeExtraAudio(track: RemoteTrack, el: HTMLAudioElement): void {
    try { track.detach(el); } catch { /* ignore */ }
    try {
      el.pause();
      el.srcObject = null;
      el.remove();
    } catch (err) {
      log.warn('[livekit-transport] extra audio teardown failed', err);
    }
    this.extraAudioElements.delete(track);
  }

  /** Replay every remote audio element from a user gesture. Calls LiveKit's
   *  ``Room.startAudio`` (resumes the shared AudioContext + plays attached
   *  elements) and then explicitly plays the host + per-track elements so a
   *  browser that blocked autoplay starts all simultaneous speakers. */
  async resumeAudioPlayback(): Promise<void> {
    const room = this.room;
    if (room) {
      try {
        await room.startAudio();
      } catch (err) {
        log.warn('[livekit-transport] room.startAudio failed', err);
      }
    }
    const elements = [this.audioElement, ...this.extraAudioElements.values()];
    for (const el of elements) {
      if (!el) continue;
      try {
        const result = el.play();
        if (result !== undefined) await result;
      } catch (err) {
        log.warn('[livekit-transport] resume audio play() failed', err);
      }
    }
  }

  private createFallbackAudioElement(): HTMLAudioElement {
    const audioElement = document.createElement('audio');
    audioElement.autoplay = true;
    audioElement.style.position = 'fixed';
    audioElement.style.opacity = '0';
    audioElement.style.pointerEvents = 'none';
    audioElement.style.width = '1px';
    audioElement.style.height = '1px';
    document.body.appendChild(audioElement);
    return audioElement;
  }

  onMessage(cb: (msg: RealtimeInboundMessage) => void): Unsubscribe {
    this.messageListeners.add(cb);
    return () => {
      this.messageListeners.delete(cb);
    };
  }

  onClose(cb: (info?: RealtimeCloseInfo) => void): Unsubscribe {
    this.closeListeners.add(cb);
    return () => {
      this.closeListeners.delete(cb);
    };
  }

  onReconnecting(cb: () => void): Unsubscribe {
    this.reconnectingListeners.add(cb);
    return () => {
      this.reconnectingListeners.delete(cb);
    };
  }

  onReconnected(cb: () => void): Unsubscribe {
    this.reconnectedListeners.add(cb);
    return () => {
      this.reconnectedListeners.delete(cb);
    };
  }

  registerRpcMethod(
    name: string,
    handler: (invocation: RpcInvocation) => Promise<string>,
  ): Unsubscribe {
    const room = this.room;
    if (!room) {
      // Pre-connect registration: parked and bound in ``_connectInner``
      // before ``room.connect``, so the method is live for an invocation
      // arriving in the join window.
      if (this.pendingRpcMethods.has(name)) {
        throw new Error(
          `RPC handler already registered for method ${name}, unregister before trying to register again`,
        );
      }
      this.pendingRpcMethods.set(name, handler);
    } else {
      this.bindRpcMethodToRoom(room, name, handler);
    }
    return () => {
      this.pendingRpcMethods.delete(name);
      // ``room`` may have been torn down between register and unregister
      // (session ended, transport swap). Guard so an unsubscribe doesn't
      // throw on a stale ref.
      const current = this.room;
      if (!current) return;
      current.localParticipant.unregisterRpcMethod(name);
    };
  }

  /** Bind one vendor-free RPC handler onto a room. LiveKit's handler
   *  signature is ``(data: RpcInvocationData) => Promise<string>`` where
   *  ``data.payload`` is the JSON-encoded args; we narrow to the vendor-free
   *  ``RpcInvocation`` at the transport boundary so SDK consumers don't
   *  import livekit-client types. */
  private bindRpcMethodToRoom(
    room: Room,
    name: string,
    handler: (invocation: RpcInvocation) => Promise<string>,
  ): void {
    room.localParticipant.registerRpcMethod(name, (data) =>
      handler({
        payload: data.payload,
        callerIdentity: data.callerIdentity,
        callerIsAgent: this.isAgentParticipant(data.callerIdentity),
      }),
    );
  }

  /** True when ``identity`` belongs to a remote participant whose kind is
   *  ``agent``. The local participant (this client) and any human remote
   *  are not agents; fails closed when the room is already torn down. */
  private isAgentParticipant(identity: string): boolean {
    const participant = this.room?.remoteParticipants.get(identity);
    return participant !== undefined && participant.kind === ParticipantKind.AGENT;
  }

  private emitMessage(message: RealtimeInboundMessage): void {
    for (const cb of this.messageListeners) cb(message);
  }

  private emitClose(info?: RealtimeCloseInfo): void {
    for (const cb of this.closeListeners) cb(info);
  }

  private handleDataReceived(payload: Uint8Array): void {
    const decoded = decodeInbound(payload, this.reassembler);
    if (decoded.status === 'pending') return;
    if (decoded.status === 'dropped') {
      log.error('[livekit-transport] envelope reassembly failed', {
        envelopeId: decoded.envelopeId,
        reason: decoded.reason,
      });
      return;
    }
    this.emitMessage(decoded.message);
  }

  private async _startSession(
    options: RealtimeConnectOptions,
  ): Promise<SessionResponse> {
    const extraHeaders = options.getAuthHeaders ? await options.getAuthHeaders() : {};
    const headers: Record<string, string> = {
      ...extraHeaders,
      'Content-Type': 'application/json',
    };
    // Bearer-authenticated external endpoint — no cookies. Default
    // ``same-origin`` credentials keep cross-origin CORS simple for
    // third-party pages (``include`` would demand
    // ``Access-Control-Allow-Credentials`` server-side for no benefit).
    let response: Response;
    try {
      response = await fetch(options.sessionStartUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(options.config),
      });
    } catch (err) {
      throw new SessionStartTransportError(
        describeFetchFailure(options.sessionStartUrl, err),
        { cause: err },
      );
    }
    if (!response.ok) {
      const detail = await parseSessionStartErrorDetail(response);
      throw sessionStartErrorFrom(
        response.status,
        response.statusText,
        detail,
        parseRetryAfter(response.headers.get('retry-after')),
      );
    }
    return (await response.json()) as SessionResponse;
  }
}

