/** N concurrent sessions per client: independent engines (streams, state,
 *  ids) and per-session teardown. Python — where every ``agent.start()``
 *  has always produced independent session state — is the cross-SDK
 *  reference. */

import { describe, expect, it, vi } from 'vitest';
import { TextEncoder as NodeTextEncoder, TextDecoder as NodeTextDecoder } from 'util';

if (typeof global.TextEncoder === 'undefined') {
  global.TextEncoder = NodeTextEncoder as typeof global.TextEncoder;
}
if (typeof global.TextDecoder === 'undefined') {
  global.TextDecoder = NodeTextDecoder as typeof global.TextDecoder;
}

import { RealtimeClient } from '../realtime_client';
import type { RealtimeSession } from '../session';
import type { ErrorEvent } from '../types';
import type { RealtimeServerMessage } from '../../transport/envelope';
import {
  collect,
  drain,
  makeFakeTransport,
  fakeSessionResponse,
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

const READY_A: RealtimeServerMessage = {
  type: 'ready',
  session_id: 'sess-a',
};
const READY_B: RealtimeServerMessage = {
  type: 'ready',
  session_id: 'sess-b',
};

/** One client over two fake transports with distinct session ids. */
async function startTwoSessions(): Promise<{
  client: RealtimeClient;
  sessionA: RealtimeSession;
  sessionB: RealtimeSession;
  fakeA: FakeTransport;
  fakeB: FakeTransport;
}> {
  const fakes: FakeTransport[] = [
    makeFakeTransport({ sessionResponse: fakeSessionResponse('sess-a') }),
    makeFakeTransport({ sessionResponse: fakeSessionResponse('sess-b') }),
  ];
  let next = 0;
  const client = new RealtimeClient({
    transportFactory: () => {
      const fake = fakes[next];
      if (fake === undefined) throw new Error('no fake transport left');
      next += 1;
      return fake;
    },
  });
  const sessionA = await client.agent().start();
  const sessionB = await client.agent().start();
  const [fakeA, fakeB] = fakes as [FakeTransport, FakeTransport];
  return { client, sessionA, sessionB, fakeA, fakeB };
}

describe('concurrent sessions on one client', () => {
  it('keeps each session wired to its own transport — streams never cross', async () => {
    const { sessionA, sessionB, fakeA, fakeB } = await startTwoSessions();

    fakeA.emitMessage(READY_A);
    fakeB.emitMessage(READY_B);
    fakeA.emitMessage(transcriptFrame('only for A'));
    fakeB.emitMessage(transcriptFrame('only for B'));

    const eventsA = await collect(sessionA, 2);
    const eventsB = await collect(sessionB, 2);
    expect(eventsA).toEqual([READY_A, transcriptFrame('only for A')]);
    expect(eventsB).toEqual([READY_B, transcriptFrame('only for B')]);
    expect(sessionA.sessionId).toBe('sess-a');
    expect(sessionB.sessionId).toBe('sess-b');
  });

  it('scopes session callbacks to that session', async () => {
    const { sessionA, sessionB, fakeA, fakeB } = await startTwoSessions();
    const heardByA: string[] = [];
    const heardByB: string[] = [];
    sessionA.on('transcript', (event) => heardByA.push(event.text));
    sessionB.on('transcript', (event) => heardByB.push(event.text));

    fakeA.emitMessage(transcriptFrame('from A'));
    fakeB.emitMessage(transcriptFrame('from B'));

    expect(heardByA).toEqual(['from A']);
    expect(heardByB).toEqual(['from B']);
  });

  it('routes each send to its own session, not the most recent one', async () => {
    const { sessionA, sessionB, fakeA, fakeB } = await startTwoSessions();
    fakeA.emitMessage(READY_A);
    fakeB.emitMessage(READY_B);

    await sessionA.sendText('for A');
    await sessionB.sendText('for B');

    expect(fakeA.sent).toEqual([{ type: 'send-text', content: 'for A' }]);
    expect(fakeB.sent).toEqual([{ type: 'send-text', content: 'for B' }]);
  });

  it('ending one session leaves the other live, then finishes both streams independently', async () => {
    const { sessionA, sessionB, fakeB } = await startTwoSessions();

    await sessionA.end();

    expect(sessionA.state).toEqual({
      kind: 'disconnected',
      disconnectReason: 'client_ended',
    });
    expect(sessionB.state.kind).toBe('connected');
    expect(await drain(sessionA)).toEqual([
      { type: 'session-ended', reason: 'client ended' },
    ]);

    fakeB.emitMessage(READY_B);
    await sessionB.end();
    const eventsB = await drain(sessionB);
    expect(eventsB).toEqual([READY_B, { type: 'session-ended', reason: 'client ended' }]);
  });
});

describe('engine lifecycle hardening', () => {
  it('a transport factory that throws rejects the start without wedging the client', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let fail = true;
    const fakes: FakeTransport[] = [];
    const client = new RealtimeClient({
      transportFactory: () => {
        if (fail) throw new Error('no transport');
        const fake = makeFakeTransport({
          sessionResponse: fakeSessionResponse('sess-after-failure'),
        });
        fakes.push(fake);
        return fake;
      },
    });

    await expect(client.agent().start()).rejects.toThrow('no transport');

    fail = false;
    const session = await client.agent().start();
    expect(session.state.kind).toBe('connected');
    expect(session.sessionId).toBe('sess-after-failure');
    await session.end();
  });

  it('restarting from the error handler opens a fresh connected session', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fakes: FakeTransport[] = [];
    const client = new RealtimeClient({
      transportFactory: () => {
        const fake = makeFakeTransport();
        fakes.push(fake);
        return fake;
      },
    });
    const errors: Array<ErrorEvent | null> = [];
    let restarted: Promise<RealtimeSession> | null = null;

    const failed = await client.agent().start();
    failed.on('error', (event) => {
      errors.push(event);
      if (event !== null && restarted === null) {
        restarted = client.agent().start();
      }
    });
    fakes[0]?.emitClose({ reason: 'livekit:ICE failed' });
    await drain(failed);
    if (restarted === null) throw new Error('error handler never fired');
    const second: RealtimeSession = await restarted;

    expect(errors[errors.length - 1]).toEqual({
      code: 'transport_disconnect',
      message: 'ICE failed',
    });
    expect(second.state.kind).toBe('connected');
    expect(failed.state.disconnectReason).toBe('transport_error');
    await second.end();
  });

  it('session_ended fires once when end() and close() race', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ transportFactory: () => fake });
    const session = await client.agent().start();
    const endings: Array<{ reason: string }> = [];
    session.on('session_ended', (event) => endings.push(event));

    await Promise.all([session.end(), session.close()]);

    expect(endings).toEqual([{ reason: 'client_ended' }]);
  });
});
