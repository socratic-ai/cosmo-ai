/**
 * Tests for the envelope chunking + reassembly transport utility.
 *
 * The wire protocol contract this module enforces is shared with the
 * backend's Python envelope module;
 * tests here cover the FE-specific glue (Uint8Array helpers, base64
 * round-trip, reassembler state machine) and the guard rails that
 * protect the renderer from a misbehaving server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// jsdom doesn't expose TextEncoder/TextDecoder on the global — same
// polyfill the other binary-handling tests in this repo use.
import { TextEncoder as NodeTextEncoder, TextDecoder as NodeTextDecoder } from 'util';

if (typeof global.TextEncoder === 'undefined') {
  global.TextEncoder = NodeTextEncoder as typeof global.TextEncoder;
}
if (typeof global.TextDecoder === 'undefined') {
  global.TextDecoder = NodeTextDecoder as typeof global.TextDecoder;
}

import type { ServerEnvelope } from '../../wire/types.gen';

import {
  base64ToBytes,
  bytesToBase64,
  buildOutboundPackets,
  chunkBytes,
  CHUNK_RAW_BYTES,
  decodeInbound,
  ENVELOPE_TTL_MS,
  EnvelopeReassembler,
  MAX_INFLIGHT_ENVELOPE_BYTES,
  MAX_INFLIGHT_ENVELOPES,
  SAFE_PACKET_BYTES,
} from '../envelope';

const encoder = new TextEncoder();

function envelopeChunks(
  envelopeId: string,
  innerJson: string,
  chunkSize: number = CHUNK_RAW_BYTES,
): ServerEnvelope[] {
  const bytes = encoder.encode(innerJson);
  const slices = chunkBytes(bytes, chunkSize);
  return slices.map((slice, seq) => ({
    type: 'server-envelope-chunk',
    envelope_id: envelopeId,
    seq,
    total: slices.length,
    data: bytesToBase64(slice),
  }));
}

describe('chunkBytes', () => {
  it('round-trips: rejoined chunks match the original payload', () => {
    const original = new Uint8Array(20_000);
    for (let i = 0; i < original.length; i++) original[i] = i & 0xff;

    const chunks = chunkBytes(original, 8_000);

    expect(chunks).toHaveLength(3);
    expect(chunks[0]!.byteLength).toBe(8_000);
    expect(chunks[1]!.byteLength).toBe(8_000);
    expect(chunks[2]!.byteLength).toBe(4_000);

    let totalBytes = 0;
    for (const c of chunks) totalBytes += c.byteLength;
    const joined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const c of chunks) {
      joined.set(c, offset);
      offset += c.byteLength;
    }
    expect(joined).toEqual(original);
  });

  it('throws on non-positive chunk size', () => {
    expect(() => chunkBytes(new Uint8Array(10), 0)).toThrow();
    expect(() => chunkBytes(new Uint8Array(10), -1)).toThrow();
  });
});

describe('base64 round-trip', () => {
  it('encodes then decodes back to the same bytes', () => {
    const original = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const b64 = bytesToBase64(original);
    const decoded = base64ToBytes(b64);
    expect(decoded).toEqual(original);
  });

  it('handles large payloads above the String.fromCharCode arg limit', () => {
    // ``bytesToBase64`` chunks by 0x8000; exercise that path with a
    // payload that crosses two windows.
    const big = new Uint8Array(0x8000 + 100);
    for (let i = 0; i < big.length; i++) big[i] = (i * 7) & 0xff;
    const decoded = base64ToBytes(bytesToBase64(big));
    expect(decoded).toEqual(big);
  });
});

describe('buildOutboundPackets', () => {
  it('passes small messages through as a single packet with no envelope id', () => {
    const result = buildOutboundPackets({ type: 'mute', muted: true });
    expect(result.envelopeId).toBeNull();
    expect(result.packets).toHaveLength(1);
  });

  it('splits oversized messages into envelope chunks sharing one envelope id', () => {
    const big = 'x'.repeat(SAFE_PACKET_BYTES + 5_000);
    const result = buildOutboundPackets({ type: 'send-text', content: big });
    expect(result.envelopeId).not.toBeNull();
    expect(result.packets.length).toBeGreaterThan(1);
    const decoded = result.packets.map((p) => JSON.parse(new TextDecoder().decode(p))) as Array<{
      type: string;
      envelope_id: string;
      seq: number;
      total: number;
    }>;
    for (const packet of decoded) {
      expect(packet.type).toBe('envelope-chunk');
      expect(packet.envelope_id).toBe(result.envelopeId);
      expect(packet.total).toBe(decoded.length);
    }
    expect(decoded.map((p) => p.seq)).toEqual(decoded.map((_, i) => i));
  });

  it('refuses to nest an already-chunked envelope-chunk message', () => {
    const oversizedEnvelope = {
      type: 'envelope-chunk' as const,
      envelope_id: 'eid',
      seq: 0,
      total: 1,
      data: 'A'.repeat(SAFE_PACKET_BYTES + 1_000),
    };
    const result = buildOutboundPackets(oversizedEnvelope);
    expect(result.packets).toHaveLength(0);
    expect(result.envelopeId).toBeNull();
  });
});

describe('EnvelopeReassembler.consume', () => {
  it('completes a 3-chunk envelope and yields the inner message', () => {
    const reassembler = new EnvelopeReassembler();
    const inner = JSON.stringify({ type: 'pong' });
    // Force 3 chunks by using a small chunk size.
    const chunks = envelopeChunks('eid-1', inner, Math.ceil(inner.length / 3));
    expect(chunks).toHaveLength(3);

    expect(reassembler.consume(chunks[0]!)).toEqual({ status: 'pending' });
    expect(reassembler.consume(chunks[1]!)).toEqual({ status: 'pending' });
    const final = reassembler.consume(chunks[2]!);
    expect(final.status).toBe('complete');
    if (final.status === 'complete') {
      expect(final.inner.type).toBe('pong');
    }
    expect(reassembler.inflightCount).toBe(0);
  });

  it('returns pending while waiting for remaining chunks', () => {
    const reassembler = new EnvelopeReassembler();
    const chunks = envelopeChunks('eid-2', JSON.stringify({ type: 'pong' }), 4);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const result = reassembler.consume(chunks[0]!);
    expect(result).toEqual({ status: 'pending' });
    expect(reassembler.inflightCount).toBe(1);
  });

  it('rejects out-of-range seq with status invalid', () => {
    const reassembler = new EnvelopeReassembler();
    const bad: ServerEnvelope = {
      type: 'server-envelope-chunk',
      envelope_id: 'eid-3',
      seq: 5,
      total: 2,
      data: bytesToBase64(encoder.encode('{}')),
    };
    const result = reassembler.consume(bad);
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.reason).toMatch(/out of range/);
    }
    expect(reassembler.inflightCount).toBe(0);
  });

  it('rejects malformed base64 with status invalid', () => {
    const reassembler = new EnvelopeReassembler();
    const bad: ServerEnvelope = {
      type: 'server-envelope-chunk',
      envelope_id: 'eid-4',
      seq: 0,
      total: 1,
      data: '!!! not base64 !!!',
    };
    const result = reassembler.consume(bad);
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.reason).toMatch(/base64/i);
    }
    expect(reassembler.inflightCount).toBe(0);
  });

  it('rejects an envelope that exceeds the per-envelope byte cap', () => {
    const reassembler = new EnvelopeReassembler();
    // Two chunks: first slips under the cap, second pushes total over.
    const halfPlus = new Uint8Array(MAX_INFLIGHT_ENVELOPE_BYTES / 2 + 1);
    const first: ServerEnvelope = {
      type: 'server-envelope-chunk',
      envelope_id: 'eid-5',
      seq: 0,
      total: 2,
      data: bytesToBase64(halfPlus),
    };
    const second: ServerEnvelope = {
      type: 'server-envelope-chunk',
      envelope_id: 'eid-5',
      seq: 1,
      total: 2,
      data: bytesToBase64(halfPlus),
    };
    expect(reassembler.consume(first).status).toBe('pending');
    const result = reassembler.consume(second);
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.reason).toMatch(/byte cap/);
    }
    expect(reassembler.inflightCount).toBe(0);
  });

  it('rejects new envelopes once the in-flight cap is hit', () => {
    const reassembler = new EnvelopeReassembler();
    for (let i = 0; i < MAX_INFLIGHT_ENVELOPES; i++) {
      const chunk: ServerEnvelope = {
        type: 'server-envelope-chunk',
        envelope_id: `eid-cap-${i}`,
        seq: 0,
        total: 2,
        data: bytesToBase64(encoder.encode('x')),
      };
      expect(reassembler.consume(chunk).status).toBe('pending');
    }
    expect(reassembler.inflightCount).toBe(MAX_INFLIGHT_ENVELOPES);

    const overflow: ServerEnvelope = {
      type: 'server-envelope-chunk',
      envelope_id: 'eid-cap-overflow',
      seq: 0,
      total: 2,
      data: bytesToBase64(encoder.encode('x')),
    };
    const result = reassembler.consume(overflow);
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.reason).toMatch(/in-flight/);
    }
    expect(reassembler.inflightCount).toBe(MAX_INFLIGHT_ENVELOPES);
  });
});

describe('EnvelopeReassembler.sweepStale', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('drops envelopes whose first chunk arrived more than TTL ago', () => {
    const reassembler = new EnvelopeReassembler();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    const chunks = envelopeChunks('eid-stale', JSON.stringify({ type: 'pong' }), 4);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(reassembler.consume(chunks[0]!).status).toBe('pending');
    expect(reassembler.inflightCount).toBe(1);

    vi.advanceTimersByTime(ENVELOPE_TTL_MS + 1);
    const dropped = reassembler.sweepStale();
    expect(dropped).toBe(1);
    expect(reassembler.inflightCount).toBe(0);
  });

  it('keeps envelopes that are still within the TTL', () => {
    const reassembler = new EnvelopeReassembler();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    const chunks = envelopeChunks('eid-fresh', JSON.stringify({ type: 'pong' }), 4);
    reassembler.consume(chunks[0]!);

    vi.advanceTimersByTime(ENVELOPE_TTL_MS - 100);
    expect(reassembler.sweepStale()).toBe(0);
    expect(reassembler.inflightCount).toBe(1);
  });
});

describe('decodeInbound', () => {
  it('passes a plain frame straight through', () => {
    const result = decodeInbound(
      encoder.encode(JSON.stringify({ type: 'pong' })),
      new EnvelopeReassembler(),
    );

    expect(result).toEqual({ status: 'message', message: { type: 'pong' } });
  });

  it('holds an incomplete envelope, then yields the reassembled inner frame', () => {
    const reassembler = new EnvelopeReassembler();
    const inner = JSON.stringify({ type: 'model-text', text: 'assembled', is_final: true });
    const chunks = envelopeChunks('eid-decode', inner, 8);
    expect(chunks.length).toBeGreaterThan(1);

    const packets = chunks.map((chunk) => encoder.encode(JSON.stringify(chunk)));
    for (const packet of packets.slice(0, -1)) {
      expect(decodeInbound(packet, reassembler)).toEqual({ status: 'pending' });
    }

    expect(decodeInbound(packets[packets.length - 1]!, reassembler)).toEqual({
      status: 'message',
      message: { type: 'model-text', text: 'assembled', is_final: true },
    });
  });

  it('surfaces an undecodable packet as the marker rather than dropping it', () => {
    const raw = '{"type": "transcript", "role":';

    const result = decodeInbound(encoder.encode(raw), new EnvelopeReassembler());

    expect(result).toEqual({ status: 'message', message: { type: null, raw } });
  });

  it('surfaces a well-formed object with no type discriminator', () => {
    const raw = JSON.stringify({ text: 'no type here' });

    const result = decodeInbound(encoder.encode(raw), new EnvelopeReassembler());

    expect(result).toEqual({ status: 'message', message: { type: null, raw } });
  });

  it('reports a refused envelope as dropped, naming the envelope', () => {
    const result = decodeInbound(
      encoder.encode(
        JSON.stringify({
          type: 'server-envelope-chunk',
          envelope_id: 'eid-bad',
          seq: 5,
          total: 2,
          data: '',
        }),
      ),
      new EnvelopeReassembler(),
    );

    expect(result).toMatchObject({ status: 'dropped', envelopeId: 'eid-bad' });
  });
});
