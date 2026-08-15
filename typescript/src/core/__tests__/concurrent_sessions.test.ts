/** N concurrent sessions per client: independent engines (streams, state,
 *  ids), the client-level compat surface targeting the most recently
 *  started live session, and client-wide teardown. Python — where every
 *  ``agent.start()`` has always produced independent session state — is
 *  the cross-SDK reference. */

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
import { NotReadyError } from '../types';
import type { ErrorEvent } from '../types';
import type { RealtimeServerMessage } from '../../transport/envelope';
import type { RealtimeConnectOptions } from '../../transport/types';
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

  it('scopes session callbacks to that session, while client callbacks aggregate', async () => {
    const { client, sessionA, sessionB, fakeA, fakeB } = await startTwoSessions();
    const heardByA: string[] = [];
    const heardByB: string[] = [];
    const heardByClient: string[] = [];
    sessionA.on('transcript', (event) => heardByA.push(event.text));
    sessionB.on('transcript', (event) => heardByB.push(event.text));
    client.on('transcript', (event) => heardByClient.push(event.text));

    fakeA.emitMessage(transcriptFrame('from A'));
    fakeB.emitMessage(transcriptFrame('from B'));

    expect(heardByA).toEqual(['from A']);
    expect(heardByB).toEqual(['from B']);
    expect(heardByClient).toEqual(['from A', 'from B']);
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

  it('targets the client-level compat surface at the most recent live session', async () => {
    const { client, sessionB, fakeA, fakeB } = await startTwoSessions();
    fakeA.emitMessage(READY_A);
    fakeB.emitMessage(READY_B);

    expect(client.getSessionId()).toBe('sess-b');
    await client.sendText('routed to B');
    expect(fakeB.sent).toEqual([{ type: 'send-text', content: 'routed to B' }]);
    expect(fakeA.sent).toEqual([]);

    await sessionB.end();

    expect(client.getSessionId()).toBe('sess-a');
    await client.sendText('routed to A');
    expect(fakeA.sent).toEqual([{ type: 'send-text', content: 'routed to A' }]);
  });

  it('client.disconnect() ends every live session', async () => {
    const { client, sessionA, sessionB } = await startTwoSessions();

    await client.disconnect();

    expect(client.isActive()).toBe(false);
    expect(sessionA.state.disconnectReason).toBe('client_ended');
    expect(sessionB.state.disconnectReason).toBe('client_ended');
    expect(await drain(sessionA)).toEqual([
      { type: 'session-ended', reason: 'client ended' },
    ]);
    expect(await drain(sessionB)).toEqual([
      { type: 'session-ended', reason: 'client ended' },
    ]);
  });

  it("clears a failed session's error from the client surface when the next session starts", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fakes: FakeTransport[] = [];
    const client = new RealtimeClient({
      transportFactory: () => {
        const fake = makeFakeTransport();
        fakes.push(fake);
        return fake;
      },
    });
    const errors: Array<{ code: string } | null> = [];
    client.on('error', (event) => errors.push(event));

    const failed = await client.agent().start();
    fakes[0]?.emitClose({ reason: 'livekit:ICE failed' });
    await drain(failed);
    await Promise.resolve();
    expect(client.getSnapshot().error).toEqual({
      code: 'transport_disconnect',
      message: 'ICE failed',
    });

    await client.agent().start();

    expect(client.getSnapshot().error).toBeNull();
    expect(errors[errors.length - 1]).toBeNull();
    await client.disconnect();
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
    expect(client.isActive()).toBe(false);

    fail = false;
    const session = await client.agent().start();
    expect(session.state.kind).toBe('connected');
    expect(client.getSessionId()).toBe('sess-after-failure');
    await session.end();
  });

  it('restarting from the error handler still clears the error banner', async () => {
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
    client.on('error', (event) => errors.push(event));
    let restarted: Promise<RealtimeSession> | null = null;
    client.on('error', (event) => {
      if (event !== null && restarted === null) {
        restarted = client.agent().start();
      }
    });

    const failed = await client.agent().start();
    fakes[0]?.emitClose({ reason: 'livekit:ICE failed' });
    await drain(failed);
    if (restarted === null) throw new Error('error handler never fired');
    const second: RealtimeSession = await restarted;

    expect(second.state.kind).toBe('connected');
    expect(errors[errors.length - 1]).toBeNull();
    expect(client.getSnapshot().error).toBeNull();
    await client.disconnect();
  });

  it('disconnect() after the server ended the session resets the client surface', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ transportFactory: () => fake });
    const session = await client.agent().start();
    fake.emitMessage(READY_A);
    fake.emitMessage({ type: 'session-ended', reason: 'max_session_duration' });
    fake.emitClose();
    await drain(session);
    await Promise.resolve();
    // A server end never moves the transport axis — the compat snapshot
    // keeps the session's last state until the caller lets go.
    expect(client.getSnapshot().transportState).toBe('ready');

    await client.disconnect();

    expect(client.getSnapshot().transportState).toBe('disconnected');
    expect(client.getLifecycleState()).toEqual({ kind: 'idle' });
  });

  it('session_ended fires once when end() and client.disconnect() race', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ transportFactory: () => fake });
    const session = await client.agent().start();
    const endings: Array<{ reason: string }> = [];
    client.on('session_ended', (event) => endings.push(event));

    await Promise.all([session.end(), client.disconnect()]);

    expect(endings).toEqual([{ reason: 'client_ended' }]);
  });

  it('disconnect() during connect cancels the in-flight start', async () => {
    const fake = makeFakeTransport();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalConnect = fake.connect.bind(fake);
    fake.connect = async (opts: RealtimeConnectOptions): Promise<void> => {
      await gate;
      await originalConnect(opts);
    };
    const client = new RealtimeClient({ transportFactory: () => fake });

    const startPromise = client.agent().start();
    // Credential resolution runs before the transport exists, so reaching
    // the gated connect can span several macrotasks.
    await vi.waitFor(() => {
      expect(client.isActive()).toBe(true);
    });

    const disconnectPromise = client.disconnect();
    release();

    await expect(startPromise).rejects.toBeInstanceOf(NotReadyError);
    await disconnectPromise;
    expect(client.isActive()).toBe(false);
    expect(client.getLifecycleState()).toEqual({ kind: 'idle' });
  });
});

describe('error retraction across detach orders', () => {
  /** Two sessions; the first fails while the second stays live, so the
   *  aggregated client ``error`` stream carries the dead session's error. */
  async function failFirstOfTwo(): Promise<{
    client: RealtimeClient;
    errors: Array<ErrorEvent | null>;
    clean: RealtimeSession;
  }> {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fakes = [makeFakeTransport(), makeFakeTransport(), makeFakeTransport()];
    let next = 0;
    const client = new RealtimeClient({
      transportFactory: () => {
        const fake = fakes[next];
        if (fake === undefined) throw new Error('no fake transport left');
        next += 1;
        return fake;
      },
    });
    const errors: Array<ErrorEvent | null> = [];
    client.on('error', (event) => errors.push(event));
    const failing = await client.agent().start();
    const clean = await client.agent().start();
    fakes[0]?.emitClose({ reason: 'livekit:ICE failed' });
    await drain(failing);
    await Promise.resolve();
    expect(errors[errors.length - 1]).toEqual({
      code: 'transport_disconnect',
      message: 'ICE failed',
    });
    return { client, errors, clean };
  }

  it("a later start retracts the error even when a clean session detached after the failed one", async () => {
    const { client, errors, clean } = await failFirstOfTwo();
    await clean.end();
    await Promise.resolve();

    await client.agent().start();

    expect(errors[errors.length - 1]).toBeNull();
    expect(client.getSnapshot().error).toBeNull();
    await client.disconnect();
  });

  it("disconnect() with nothing live retracts a dead session's error", async () => {
    const { client, errors, clean } = await failFirstOfTwo();
    await clean.end();
    await Promise.resolve();

    await client.disconnect();

    expect(errors[errors.length - 1]).toBeNull();
  });

  it('setError(null) retracts the aggregated error when no session is live', async () => {
    const { client, errors, clean } = await failFirstOfTwo();
    await clean.end();
    await Promise.resolve();

    client.setError(null);

    expect(errors[errors.length - 1]).toBeNull();
    expect(client.getSnapshot().error).toBeNull();
  });

  it("setError(null) retracts a dead session's error while a clean session is live", async () => {
    const { client, errors, clean } = await failFirstOfTwo();

    client.setError(null);

    expect(errors[errors.length - 1]).toBeNull();
    expect(clean.state.kind).toBe('connected');
    await client.disconnect();
  });
});
