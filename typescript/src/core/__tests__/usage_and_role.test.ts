/** ``cosmo.usage`` surfacing and transcript-role normalization.
 *
 *  Python's ``tests/test_session_stream.py`` is the cross-SDK spec for both:
 *  usage is a typed event there (``UsageEvent``), and the role enum
 *  decodes any casing rather than guessing. */

import { describe, expect, it, vi } from 'vitest';

import { RealtimeClient } from '../realtime_client';
import { makeFakeTransport, type FakeTransport } from './test_helpers';
import type { UsageEvent } from '../events';
import type { RealtimeServerMessage } from '../../transport/envelope';

/** Emit a transcript/turn frame carrying a role the wire type does not allow.
 *  The cast is the point: these cases simulate a wire that grew a new role or
 *  changed casing, which the static type cannot express. */
function emitRawRole(fake: FakeTransport, frame: Record<string, unknown>): void {
  fake.emitMessage(frame as unknown as RealtimeServerMessage);
}

async function connectedSession(): Promise<{ fake: FakeTransport; client: RealtimeClient }> {
  const fake = makeFakeTransport();
  const client = new RealtimeClient({ transportFactory: () => fake });
  await client.agent().start();
  return { fake, client };
}

describe('cosmo.usage', () => {
  it('surfaces token counts instead of dropping the frame', async () => {
    const { fake, client } = await connectedSession();
    const seen: UsageEvent[] = [];
    client.on('usage', (u) => seen.push(u));

    fake.emitMessage({
      type: 'cosmo.usage',
      input_text_tokens: 12,
      output_audio_tokens: 46,
      total_tokens: 58,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      inputTextTokens: 12,
      outputAudioTokens: 46,
      totalTokens: 58,
    });
    // Absent counters read as zero, not undefined.
    expect(seen[0].inputCachedTokens).toBe(0);
  });

  it('reports each event as a cumulative total, not a delta', async () => {
    const { fake, client } = await connectedSession();
    const seen: UsageEvent[] = [];
    client.on('usage', (u) => seen.push(u));

    fake.emitMessage({ type: 'cosmo.usage', total_tokens: 10 });
    fake.emitMessage({ type: 'cosmo.usage', total_tokens: 25 });

    expect(seen.map((u) => u.totalTokens)).toEqual([10, 25]);
  });
});

describe('transcript role normalization', () => {
  it('accepts the wire casing and any other casing', async () => {
    const { fake, client } = await connectedSession();
    const roles: string[] = [];
    client.on('transcript', (t) => roles.push(t.role));

    for (const role of ['USER', 'user', 'ASSISTANT', 'Assistant']) {
      emitRawRole(fake, { type: 'transcript', role, text: 'x', is_final: true });
    }

    expect(roles).toEqual(['user', 'user', 'assistant', 'assistant']);
  });

  it('drops an unknown role rather than filing it under assistant', async () => {
    const { fake, client } = await connectedSession();
    const seen: string[] = [];
    client.on('transcript', (t) => seen.push(t.role));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    emitRawRole(fake, { type: 'transcript', role: 'NARRATOR', text: 'x', is_final: true });

    expect(seen).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('NARRATOR'));
    warn.mockRestore();
  });

  it('drops a turn-complete with an unknown role', async () => {
    const { fake, client } = await connectedSession();
    const seen: string[] = [];
    client.on('turn_complete', (t) => seen.push(t.role));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    emitRawRole(fake, { type: 'turn-complete', role: 'NARRATOR' });
    fake.emitMessage({ type: 'turn-complete', role: 'ASSISTANT' });

    expect(seen).toEqual(['assistant']);
    warn.mockRestore();
  });
});
