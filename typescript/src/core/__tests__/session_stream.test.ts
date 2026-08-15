/** Event-stream semantics for ``RealtimeSession``: unknown-event tolerance,
 *  session-ended finality, queue bounds, the formal lifecycle machine, and
 *  the wire shapes of the send methods. Python's
 *  ``tests/test_session_stream.py`` is the cross-SDK spec; Swift's
 *  ``RealtimeSession.State``/``EndReason`` is the state-machine precedent. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { TextEncoder as NodeTextEncoder, TextDecoder as NodeTextDecoder } from 'util';

if (typeof global.TextEncoder === 'undefined') {
  global.TextEncoder = NodeTextEncoder as typeof global.TextEncoder;
}
if (typeof global.TextDecoder === 'undefined') {
  global.TextDecoder = NodeTextDecoder as typeof global.TextDecoder;
}

import { RealtimeClient } from '../realtime_client';
import type { RealtimeSession } from '../session';
import type { SessionLifecycleState } from '../state';
import { SessionStartError } from '../../transport/session_start_error';
import type { RealtimeServerMessage } from '../../transport/envelope';
import {
  collect,
  drain,
  makeFakeTransport,
  transcriptFrame,
  type FakeTransport,
} from './test_helpers';

vi.mock('livekit-client', () => {
  class Room {
    localParticipant = { setMicrophoneEnabled: vi.fn() };
    on() {
      return this;
    }
    async connect() {}
    async disconnect() {}
  }
  return {
    Room,
    RoomEvent: {
      DataReceived: 'dataReceived',
      TrackSubscribed: 'trackSubscribed',
      Disconnected: 'disconnected',
      Reconnecting: 'reconnecting',
      Reconnected: 'reconnected',
    },
    Track: { Kind: { Audio: 'audio' }, Source: { Microphone: 'microphone' } },
    ConnectionState: { Connected: 'connected' },
    LocalVideoTrack: class {},
    RemoteTrack: class {},
  };
});

const READY_FRAME: RealtimeServerMessage = {
  type: 'ready',
  session_id: 'sess-test',
};

async function startSession(): Promise<{
  client: RealtimeClient;
  session: RealtimeSession;
  fake: FakeTransport;
}> {
  const fake = makeFakeTransport();
  const client = new RealtimeClient({ transportFactory: () => fake });
  const session = await client.agent().start();
  return { client, session, fake };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RealtimeSession stream', () => {
  it('yields ready, tolerates unknown event types, and keeps flowing', async () => {
    const { session, fake } = await startSession();

    fake.emitMessage(READY_FRAME);
    fake.emitMessage({
      type: 'telemetry-snapshot',
      metrics: { rtt_ms: 42 },
    } as unknown as RealtimeServerMessage);
    fake.emitMessage(transcriptFrame('Still here.'));

    const [ready, unknown, transcript] = await collect(session, 3);
    expect(ready).toEqual(READY_FRAME);
    expect(unknown).toEqual({
      type: 'unknown',
      rawType: 'telemetry-snapshot',
      payload: { type: 'telemetry-snapshot', metrics: { rtt_ms: 42 } },
    });
    expect(transcript).toEqual(transcriptFrame('Still here.'));
    expect(session.state.kind).toBe('connected');
  });

  it('folds a server session-ended frame into the always-final terminal item', async () => {
    const { session, fake } = await startSession();

    fake.emitMessage(READY_FRAME);
    fake.emitMessage({ type: 'session-ended', reason: 'max_session_duration' });
    // A frame racing the close still flows — the terminal item stays final.
    fake.emitMessage(transcriptFrame('late frame'));
    fake.emitClose();

    const events = await drain(session);
    expect(events[0]).toEqual(READY_FRAME);
    expect(events[1]).toEqual(transcriptFrame('late frame'));
    expect(events[2]).toEqual({ type: 'session-ended', reason: 'max_session_duration' });
    expect(events).toHaveLength(3);
    expect(session.state).toMatchObject({
      kind: 'disconnected',
      disconnectReason: 'server_ended',
    });
  });

  it('session-ended with no transport close finishes after the grace timer', async () => {
    vi.useFakeTimers();
    try {
      const { session, fake } = await startSession();

      fake.emitMessage(READY_FRAME);
      fake.emitMessage({ type: 'session-ended', reason: 'worker done' });
      // No close follows — the grace timer must force the clean teardown.
      await vi.advanceTimersByTimeAsync(6_000);

      const events = await drain(session);
      expect(events[events.length - 1]).toEqual({
        type: 'session-ended',
        reason: 'worker done',
      });
      expect(session.state).toMatchObject({
        kind: 'disconnected',
        disconnectReason: 'server_ended',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('close() synthesizes a client-closed terminal without the wire end frame', async () => {
    const { session, fake } = await startSession();

    await session.close();
    await session.close(); // idempotent

    const events = await drain(session);
    expect(events).toEqual([{ type: 'session-ended', reason: 'client closed' }]);
    expect(session.state.disconnectReason).toBe('client_closed');
    expect(fake.lastDisconnectOpts()).toEqual({ sendEndFrame: false });
  });

  it('a bare deliberate server close finishes the stream with the reason as terminal detail', async () => {
    const { session, fake } = await startSession();

    fake.emitMessage(READY_FRAME);
    fake.emitClose({ reason: 'livekit:ROOM_DELETED' });

    const events = await drain(session);
    expect(events[0]).toEqual(READY_FRAME);
    expect(events[1]).toEqual({ type: 'session-ended', reason: 'ROOM_DELETED' });
    expect(events).toHaveLength(2);
    expect(session.state).toMatchObject({
      kind: 'disconnected',
      disconnectReason: 'server_ended',
      detail: 'ROOM_DELETED',
    });
  });

  it('end() synthesizes exactly one terminal event and is idempotent', async () => {
    const { client, session } = await startSession();

    await session.end();
    await session.end(); // idempotent

    const events = await drain(session);
    expect(events).toEqual([{ type: 'session-ended', reason: 'client ended' }]);
    // Latched: the engine machine resets to idle for the next run, but this
    // session stays disconnected forever.
    expect(session.state.kind).toBe('disconnected');
    expect(session.state.disconnectReason).toBe('client_ended');
    expect(client.getLifecycleState()).toEqual({ kind: 'idle' });
  });

  it('drops overflow past the queue bound but still delivers the terminal item', async () => {
    const { session, fake } = await startSession();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    for (let i = 0; i < 1030; i++) {
      fake.emitMessage(transcriptFrame(`t${String(i)}`));
    }
    await session.end();

    const events = await drain(session);
    // 1024-slot cap: 6 dropped off the tail, then the terminal evicts the
    // oldest buffered event (t0) instead of being dropped itself.
    expect(warn).toHaveBeenCalledTimes(6);
    expect(events).toHaveLength(1024);
    expect(events[events.length - 1]).toEqual({
      type: 'session-ended',
      reason: 'client ended',
    });
    expect(events[0]).toEqual(transcriptFrame('t1'));
    expect(events[events.length - 2]).toEqual(transcriptFrame('t1023'));
  });

  it('supports a single stream consumer', async () => {
    const { session } = await startSession();
    const iterator = session[Symbol.asyncIterator]();

    const first = iterator.next();
    await expect(iterator.next()).rejects.toThrow(
      'RealtimeSession supports a single stream consumer.',
    );

    await session.end();
    await expect(first).resolves.toEqual({
      value: { type: 'session-ended', reason: 'client ended' },
      done: false,
    });
  });

  it('rejects start() on a handshake failure — no session escapes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fake = makeFakeTransport({
      connectError: new SessionStartError(403, 'Forbidden', {
        code: 'workspace_forbidden',
        message: 'not allowed',
      }),
    });
    const client = new RealtimeClient({ transportFactory: () => fake });

    await expect(client.agent().start()).rejects.toBeInstanceOf(SessionStartError);

    expect(client.getLifecycleState()).toMatchObject({
      kind: 'disconnected',
      disconnectReason: 'handshake_failed',
      detail: 'not allowed',
    });
  });
});

describe('session lifecycle machine', () => {
  it('walks connecting → connected ↔ reconnecting → disconnected(client_ended) → idle', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ transportFactory: () => fake });
    const states: SessionLifecycleState[] = [];
    client.on('lifecycle', (state) => states.push(state));

    const session = await client.agent().start();
    fake.emitReconnecting();
    fake.emitReconnected();
    await session.end();

    expect(states.map((state) => state.kind)).toEqual([
      'idle', // current state, replayed on subscribe
      'connecting',
      'connected',
      'reconnecting',
      'connected',
      'disconnected',
      'idle',
    ]);
    expect(states[5]).toEqual({ kind: 'disconnected', disconnectReason: 'client_ended' });
    expect(session.state).toEqual({
      kind: 'disconnected',
      disconnectReason: 'client_ended',
    });
  });

  it('maps an unsolicited transport close to transport_error with detail', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client, session, fake } = await startSession();
    const states: SessionLifecycleState[] = [];
    client.on('lifecycle', (state) => states.push(state));

    fake.emitClose({ reason: 'livekit:ICE failed' });
    // The close handler awaits the Stop hooks before the terminal
    // lifecycle publish, so the transition lands a microtask later.
    await Promise.resolve();

    expect(states).toEqual([
      { kind: 'connected' }, // current state, replayed on subscribe
      { kind: 'disconnected', disconnectReason: 'transport_error', detail: 'ICE failed' },
    ]);
    const events = await drain(session);
    expect(events).toEqual([{ type: 'session-ended', reason: 'ICE failed' }]);
    expect(session.state.disconnectReason).toBe('transport_error');
  });
});

describe('send wire shapes', () => {
  it('sendText publishes a bare send-text frame', async () => {
    const { session, fake } = await startSession();
    fake.emitMessage(READY_FRAME); // transport must be live before the first send

    await session.sendText('hi');

    expect(fake.sent[0]).toEqual({ type: 'send-text', content: 'hi' });
    expect(fake.sent[0]).not.toHaveProperty('options');
  });

  it('sendContext publishes a send-context frame and emits nothing locally', async () => {
    const { client, session, fake } = await startSession();
    fake.emitMessage(READY_FRAME);
    const echoed: string[] = [];
    client.on('transcript', (event) => echoed.push(event.text));

    await session.sendContext('now on References (section 6 of 7).');
    await session.sendContext('   ');

    expect(fake.sent).toEqual([
      { type: 'send-context', content: 'now on References (section 6 of 7).' },
    ]);
    expect(echoed).toEqual([]);
  });

  it('sendText with transcript:false publishes the turn without echoing it locally', async () => {
    const { client, session, fake } = await startSession();
    fake.emitMessage(READY_FRAME);
    const echoed: string[] = [];
    client.on('transcript', (event) => echoed.push(event.text));

    await session.sendText('[reading] now on References', { transcript: false });
    await session.sendText('shown');

    expect(fake.sent[0]).toEqual({
      type: 'send-text',
      content: '[reading] now on References',
    });
    expect(echoed).toEqual(['shown']);
  });
});

describe('callback surface guarantees', () => {
  it('session_ended fires exactly once with client_ended on session.end()', async () => {
    const { session } = await startSession();
    const endings: Array<{ reason: string }> = [];
    session.on('session_ended', (e) => endings.push(e));

    await session.end();
    await session.end(); // idempotent — must not re-fire

    expect(endings).toEqual([{ reason: 'client_ended' }]);
  });

  it('session_ended fires once with the server slug on a server end', async () => {
    const { session, fake } = await startSession();
    const endings: Array<{ reason: string }> = [];
    session.on('session_ended', (e) => endings.push(e));

    fake.emitMessage(READY_FRAME);
    fake.emitMessage({ type: 'session-ended', reason: 'max_session_duration' });
    fake.emitClose();
    await drain(session);

    expect(endings).toEqual([{ reason: 'max_session_duration' }]);
  });

  it('replays the current lifecycle state to late subscribers', async () => {
    const { session, fake } = await startSession();
    fake.emitMessage(READY_FRAME);

    const seen: SessionLifecycleState[] = [];
    session.on('lifecycle', (s) => seen.push(s));

    expect(seen).toHaveLength(1);
    expect(seen[0].kind).toBe('connected');
  });

  it('replays ready to subscribers that attach after it fired', async () => {
    const { session, fake } = await startSession();
    fake.emitMessage(READY_FRAME);

    const readies: Array<{ sessionId: string }> = [];
    session.on('ready', (r) => readies.push(r));

    expect(readies).toEqual([
      {
        sessionId: 'sess-test',
        rejectedTools: [],
        maxSessionSeconds: null,
        agent: null,
      },
    ]);
  });
});
