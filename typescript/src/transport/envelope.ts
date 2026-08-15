/**
 * Envelope chunking + reassembly for the realtime data-channel protocol.
 *
 * LiveKit's reliable data channel has a practical per-packet ceiling
 * (~16 KiB end-to-end). Logical protocol messages that don't fit get
 * split into ``server-envelope-chunk`` / ``envelope-chunk`` packets keyed
 * by a shared ``envelope_id``. The receiver reassembles, validates, and
 * hands the inner payload back as if it had arrived in one piece.
 *
 * This module is the single source of truth for the constants and the
 * assembly state machine on the FE. Outbound chunking
 * (``buildOutboundPackets``) and inbound reassembly
 * (``EnvelopeReassembler``) live here so a tweak to the chunk size or
 * memory cap lands in one place.
 *
 * Mirrors the backend's Python envelope module. Constant
 * names match across both languages (SCREAMING_SNAKE_CASE either side)
 * so wire-protocol invariants are obvious by grep.
 */

import { log } from '../core/logger';
import type {
  BotLlmStartedEvent,
  BotLlmStoppedEvent,
  BotStartedSpeakingEvent,
  BotStoppedSpeakingEvent,
  BotTtsStartedEvent,
  BotTtsStoppedEvent,
  ClientActivityEnd,
  ClientBindInput,
  ClientContext,
  ClientEnd,
  ClientEnvelope,
  ClientImage,
  ClientMute,
  ClientPing,
  ClientText,
  SessionStateWriteEvent,
  ToolJobResult,
  UsageEvent,
  UserSpeechTimeoutEvent,
  ErrorEvent,
  ModelTextEvent,
  PongEvent,
  ReadyEvent,
  ReconnectingEvent,
  ServerEnvelope,
  SessionEndedEvent,
  SessionEndingSoonEvent,
  ToolCallEvent,
  ToolDispatchStartedEvent,
  ToolInvocationEvent,
  ToolResultEvent,
  TranscriptDeltaEvent,
  TurnCompleteEvent,
  UserStartedSpeakingEvent,
  UserStoppedSpeakingEvent,
} from '../wire/types.gen';

export type RealtimeClientMessage =
  | ClientMute
  | ClientEnd
  | ClientPing
  | ClientActivityEnd
  | ClientBindInput
  | ClientText
  | ClientContext
  | ClientImage
  | ToolJobResult
  | ClientEnvelope;

/** Server messages exposed to handlers — the external protocol's
 *  server union. The transport unwraps ``server-envelope-chunk``
 *  carriers before dispatch, so the envelope type intentionally does
 *  NOT appear here. */
export type RealtimeServerMessage =
  | ReadyEvent
  | TranscriptDeltaEvent
  | ModelTextEvent
  | TurnCompleteEvent
  | UserStartedSpeakingEvent
  | UserStoppedSpeakingEvent
  | UserSpeechTimeoutEvent
  | BotStartedSpeakingEvent
  | BotStoppedSpeakingEvent
  | BotLlmStartedEvent
  | BotLlmStoppedEvent
  | BotTtsStartedEvent
  | BotTtsStoppedEvent
  | ToolCallEvent
  | ToolDispatchStartedEvent
  | ToolResultEvent
  | ToolInvocationEvent
  | UsageEvent
  | SessionStateWriteEvent
  | ReconnectingEvent
  | SessionEndingSoonEvent
  | SessionEndedEvent
  | ErrorEvent
  | PongEvent;

/** A packet that could not be decoded into a wire frame at all: malformed
 *  JSON, a non-object, or an object with no ``type`` discriminator. Carried
 *  through the message path rather than dropped — the external protocol
 *  surfaces an undecodable frame as an ``unknown`` stream item, and a
 *  dropped one is indistinguishable from a frame the server never sent. */
export type RealtimeUndecodableFrame = {
  type: null;
  /** The packet text as received. */
  raw: string;
};

/** What a transport hands its message subscribers: a decoded server frame,
 *  or the marker for a packet that could not be decoded. */
export type RealtimeInboundMessage =
  | RealtimeServerMessage
  | RealtimeUndecodableFrame;

// Per-packet wire budget. LiveKit's reliable channel will accept larger
// packets but we keep a comfortable margin to absorb base64 + envelope
// JSON overhead. ``CHUNK_RAW_BYTES`` is the inner-bytes budget per chunk;
// the resulting envelope JSON stays under ``SAFE_PACKET_BYTES``.
export const SAFE_PACKET_BYTES = 12_000;
export const CHUNK_RAW_BYTES = 8_000;

// Reassembly guard rails. A peer that opens an envelope and never sends
// the last chunk would otherwise leak bytes per session.
export const MAX_INFLIGHT_ENVELOPES = 8;
export const MAX_INFLIGHT_ENVELOPE_BYTES = 4 * 1024 * 1024;
export const ENVELOPE_TTL_MS = 30_000;

const CLIENT_ENVELOPE_TYPE = 'envelope-chunk';
const SERVER_ENVELOPE_TYPE = 'server-envelope-chunk';

// Lazy-init so module load doesn't require ``TextEncoder``/``TextDecoder``
// to already exist on the global — jest's jsdom env doesn't expose
// them until the test file's polyfill runs.
let _decoder: TextDecoder | null = null;
let _encoder: TextEncoder | null = null;
function getDecoder(): TextDecoder {
  if (_decoder === null) _decoder = new TextDecoder();
  return _decoder;
}
function getEncoder(): TextEncoder {
  if (_encoder === null) _encoder = new TextEncoder();
  return _encoder;
}

/** Split ``payload`` into contiguous slices of at most ``size`` bytes. */
export function chunkBytes(payload: Uint8Array, size: number): Uint8Array[] {
  if (size <= 0) throw new Error('chunk size must be positive');
  const chunks: Uint8Array[] = [];
  for (let off = 0; off < payload.byteLength; off += size) {
    chunks.push(payload.subarray(off, Math.min(off + size, payload.byteLength)));
  }
  return chunks;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const STEP = 0x8000;
  for (let i = 0; i < bytes.byteLength; i += STEP) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + STEP, bytes.byteLength)),
    );
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Tagged wire-parse result. ``kind`` narrows cleanly without casts. */
export type ParsedWire =
  | { kind: 'envelope'; message: ServerEnvelope }
  | { kind: 'plain'; message: RealtimeServerMessage };

/** Parse a wire packet (raw or assembled envelope inner) into a tagged
 *  ``ParsedWire``. Validates only the ``type`` discriminator shape — the
 *  codegen union guarantees field-level types per variant. Returns
 *  ``null`` on parse / shape failure. */
export function parseWireMessage(payload: Uint8Array): ParsedWire | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(getDecoder().decode(payload));
  } catch (err) {
    log.warn('[realtime-envelope] failed to parse data packet', err);
    return null;
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { type?: unknown }).type !== 'string'
  ) {
    log.warn('[realtime-envelope] data packet missing type', parsed);
    return null;
  }
  const type = (parsed as { type: string }).type;
  if (type === SERVER_ENVELOPE_TYPE) {
    return { kind: 'envelope', message: parsed as ServerEnvelope };
  }
  return { kind: 'plain', message: parsed as RealtimeServerMessage };
}

function generateEnvelopeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export type OutboundPackets = {
  /** JSON-encoded packets to publish over the data channel, in order. */
  packets: Uint8Array[];
  /** Shared envelope id when the message was chunked, ``null`` otherwise. */
  envelopeId: string | null;
};

/** Build the wire packets for one outbound client message.
 *
 *  Small messages (``<= SAFE_PACKET_BYTES``) pass through as a single
 *  packet. Oversized messages are split into ``envelope-chunk`` packets
 *  sharing one ``envelopeId``. Attempting to chunk an already-chunked
 *  ``envelope-chunk`` message returns an empty packet list (the caller
 *  must drop and log — nesting envelopes is never legal).
 */
export function buildOutboundPackets(message: RealtimeClientMessage): OutboundPackets {
  const encoder = getEncoder();
  const payload = encoder.encode(JSON.stringify(message));
  if (payload.byteLength <= SAFE_PACKET_BYTES) {
    return { packets: [payload], envelopeId: null };
  }
  if (message.type === CLIENT_ENVELOPE_TYPE) {
    return { packets: [], envelopeId: null };
  }
  const envelopeId = generateEnvelopeId();
  const slices = chunkBytes(payload, CHUNK_RAW_BYTES);
  const packets: Uint8Array[] = [];
  for (let seq = 0; seq < slices.length; seq++) {
    const slice = slices[seq];
    if (!slice) continue;
    const chunk: ClientEnvelope = {
      type: CLIENT_ENVELOPE_TYPE,
      envelope_id: envelopeId,
      seq,
      total: slices.length,
      data: bytesToBase64(slice),
    };
    packets.push(encoder.encode(JSON.stringify(chunk)));
  }
  return { packets, envelopeId };
}

/** Outcome of feeding one chunk to ``EnvelopeReassembler``.
 *
 *  Three mutually exclusive states discriminated by ``status``:
 *  ``pending`` (more chunks expected), ``complete`` (inner message
 *  ready), ``invalid`` (envelope dropped, caller logs ``reason``).
 *  Mirrors the Python ``AssemblyResult`` dataclass.
 */
export type AssemblyResult =
  | { status: 'pending' }
  | { status: 'complete'; inner: RealtimeServerMessage }
  | { status: 'invalid'; reason: string };

type EnvelopeBuffer = {
  total: number;
  parts: (Uint8Array | null)[];
  createdAt: number;
  bytesSoFar: number;
};

/** Buffers inbound envelope chunks, emits the inner message on completion.
 *
 *  Caller pattern:
 *
 *      const result = reassembler.consume(chunk);
 *      if (result.status === 'invalid') {
 *        // log result.reason
 *      } else if (result.status === 'complete') {
 *        // dispatch result.inner
 *      } else {
 *        // mid-stream, wait for more chunks
 *      }
 */
export class EnvelopeReassembler {
  private buffers = new Map<string, EnvelopeBuffer>();

  consume(chunk: ServerEnvelope): AssemblyResult {
    const { envelope_id: envelopeId, seq, total, data } = chunk;
    if (seq == null || total == null || seq < 0 || total <= 0 || seq >= total) {
      return {
        status: 'invalid',
        reason: `envelope seq/total out of range: seq=${seq} total=${total}`,
      };
    }
    this.sweepStale();
    const existing = this.buffers.get(envelopeId);
    if (existing === undefined && this.buffers.size >= MAX_INFLIGHT_ENVELOPES) {
      return { status: 'invalid', reason: 'too many in-flight envelopes' };
    }
    let buf = existing;
    if (buf === undefined) {
      buf = {
        total,
        parts: new Array(total).fill(null) as (Uint8Array | null)[],
        createdAt: Date.now(),
        bytesSoFar: 0,
      };
      this.buffers.set(envelopeId, buf);
    }
    if (buf.total !== total) {
      this.buffers.delete(envelopeId);
      return { status: 'invalid', reason: 'envelope total inconsistent' };
    }
    let decoded: Uint8Array;
    try {
      decoded = base64ToBytes(data ?? '');
    } catch (err) {
      this.buffers.delete(envelopeId);
      return {
        status: 'invalid',
        reason: `invalid base64 envelope chunk: ${(err as Error).message}`,
      };
    }
    buf.bytesSoFar += decoded.byteLength;
    if (buf.bytesSoFar > MAX_INFLIGHT_ENVELOPE_BYTES) {
      this.buffers.delete(envelopeId);
      return { status: 'invalid', reason: 'envelope exceeded byte cap' };
    }
    buf.parts[seq] = decoded;
    for (const part of buf.parts) {
      if (part === null) return { status: 'pending' };
    }
    this.buffers.delete(envelopeId);
    let totalBytes = 0;
    for (const part of buf.parts) totalBytes += (part as Uint8Array).byteLength;
    const joined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const part of buf.parts) {
      joined.set(part as Uint8Array, offset);
      offset += (part as Uint8Array).byteLength;
    }
    const inner = parseWireMessage(joined);
    if (inner === null) {
      return { status: 'invalid', reason: 'invalid envelope inner JSON' };
    }
    if (inner.kind === 'envelope') {
      return { status: 'invalid', reason: 'nested envelope chunks are not allowed' };
    }
    return { status: 'complete', inner: inner.message };
  }

  /** Drop envelopes whose first chunk arrived more than TTL ago.
   *  Returns the number of envelopes dropped. */
  sweepStale(): number {
    const now = Date.now();
    const stale: string[] = [];
    for (const [eid, buf] of this.buffers) {
      if (now - buf.createdAt > ENVELOPE_TTL_MS) stale.push(eid);
    }
    for (const eid of stale) this.buffers.delete(eid);
    return stale.length;
  }

  clear(): void {
    this.buffers.clear();
  }

  get inflightCount(): number {
    return this.buffers.size;
  }
}

/** Outcome of decoding one inbound packet. ``pending`` is a mid-stream
 *  envelope chunk with nothing to dispatch yet; ``dropped`` is an envelope
 *  the reassembler refused (``reason`` is for the log). */
export type InboundDecode =
  | { status: 'message'; message: RealtimeInboundMessage }
  | { status: 'pending' }
  | { status: 'dropped'; reason: string; envelopeId: string };

/** Decode one inbound wire packet, reassembling envelope chunks across
 *  calls against the caller's ``reassembler``.
 *
 *  The single inbound decode path: transports feed packets here rather than
 *  re-implementing parse + reassembly, so the contract suite exercises the
 *  same code the LiveKit transport runs. An undecodable packet resolves to
 *  the ``RealtimeUndecodableFrame`` marker, not a drop. */
export function decodeInbound(
  payload: Uint8Array,
  reassembler: EnvelopeReassembler,
): InboundDecode {
  const wire = parseWireMessage(payload);
  if (wire === null) {
    return {
      status: 'message',
      message: { type: null, raw: getDecoder().decode(payload) },
    };
  }
  if (wire.kind === 'plain') return { status: 'message', message: wire.message };
  const result = reassembler.consume(wire.message);
  if (result.status === 'pending') return { status: 'pending' };
  if (result.status === 'invalid') {
    return {
      status: 'dropped',
      reason: result.reason,
      envelopeId: wire.message.envelope_id,
    };
  }
  return { status: 'message', message: result.inner };
}
