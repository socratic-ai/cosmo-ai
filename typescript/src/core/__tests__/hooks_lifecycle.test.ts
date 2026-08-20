/** The engine-level seams of the lifecycle hooks: ``SessionStart`` folds
 *  context into the session-config the transport receives, ``SessionEnd`` fires
 *  exactly once per session on every exit path, and a fired server-runtime
 *  silence timeout dispatches ``UserSpeechTimeout``. Python's
 *  ``tests/test_hooks_integration.py`` is the cross-SDK reference. */

import { describe, expect, it, vi } from 'vitest';
import { TextEncoder as NodeTextEncoder, TextDecoder as NodeTextDecoder } from 'util';

if (typeof global.TextEncoder === 'undefined') {
  global.TextEncoder = NodeTextEncoder as typeof global.TextEncoder;
}
if (typeof global.TextDecoder === 'undefined') {
  global.TextDecoder = NodeTextDecoder as typeof global.TextDecoder;
}

import { RealtimeClient } from '../realtime_client';
import { type Hook,
  sessionEnd,
  sessionStart,
  type SessionEndContext } from '../hooks';
import { SessionStartError } from '../../transport/session_start_error';
import { inlineAgent, makeFakeTransport } from './test_helpers';

vi.mock('livekit-client', () => ({
  Room: class {},
  RoomEvent: {},
  Track: { Kind: { Audio: 'audio' }, Source: { Microphone: 'microphone' } },
  ConnectionState: { Connected: 'connected' },
  LocalVideoTrack: class {},
  RemoteTrack: class {},
}));

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('SessionStart', () => {
  it('appends the hook context to the sent instructions', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ transportFactory: () => fake });
    const hooks: Hook[] = [];
    hooks.push(sessionStart(() => ({ additionalContext: 'Caller is a VIP.' })));

    await client.agent({ instructions: 'Be helpful.', hooks }).start();

    expect(inlineAgent(fake.lastConfig())?.instructions).toBe(
      'Be helpful.\n\nCaller is a VIP.',
    );
  });

  it('becomes the sole instructions when the agent sets none', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ transportFactory: () => fake });
    const hooks: Hook[] = [];
    hooks.push(sessionStart(() => ({ additionalContext: 'Context only.' })));

    await client.agent({ hooks }).start();

    expect(inlineAgent(fake.lastConfig())?.instructions).toBe('Context only.');
  });

  it('is not injected into a catalog agent — the stored config runs verbatim', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ transportFactory: () => fake });
    const hooks: Hook[] = [];
    hooks.push(sessionStart(() => ({ additionalContext: 'Caller is a VIP.' })));

    await client.catalogAgent('driver-pay', { hooks }).start();

    const agent = fake.lastConfig()?.agent;
    expect(agent?.type).toBe('catalog');
    expect(agent).not.toHaveProperty('instructions');
  });

  it('leaves the config untouched when no hook contributes context', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ transportFactory: () => fake });
    const hooks: Hook[] = [];
    hooks.push(sessionStart(() => undefined));

    await client.agent({ instructions: 'Be helpful.', hooks }).start();

    expect(inlineAgent(fake.lastConfig())?.instructions).toBe('Be helpful.');
  });

  it('fires SessionEnd once and rejects with session_start_hook_failed when the fold throws', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ transportFactory: () => fake });
    const hooks: Hook[] = [];
    const stops: SessionEndContext[] = [];
    hooks.push(sessionEnd((ctx) => {
      stops.push(ctx);
    }));
    // A throwing CALLBACK is isolated; a fold failure needs the fold itself
    // to throw — a result whose additionalContext accessor explodes does it.
    hooks.push(
      sessionStart(() => ({
        get additionalContext(): string {
          throw new Error('fold exploded');
        },
      })),
    );

    await expect(client.agent({ hooks }).start()).rejects.toMatchObject({
      name: 'SessionStartError',
      detail: { code: 'session_start_hook_failed', message: 'fold exploded' },
    });

    expect(stops).toEqual([
      { event: 'SessionEnd', reason: 'handshake_failed', detail: 'fold exploded', sessionId: null },
    ]);
  });
});

describe('unified hooks list', () => {
  it('carries client hooks and server hooks in one list', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ transportFactory: () => fake });
    const silence = {
      trigger: 'user.speech.timeout' as const,
      timeout_seconds: 45,
      action: { type: 'end_call' as const },
    };

    await client
      .agent({ hooks: [sessionStart(() => ({ additionalContext: 'ctx' })), silence] })
      .start();

    const agent = inlineAgent(fake.lastConfig());
    expect(agent?.instructions).toBe('ctx');
    expect(agent?.hooks).toEqual([silence]);
  });

  it('rejects a list element that is neither kind at agent build', () => {
    const client = new RealtimeClient({ transportFactory: () => makeFakeTransport() });
    expect(() => client.agent({ hooks: [{ nonsense: true } as never] })).toThrow(
      /seam-factory Hooks or server hooks/,
    );
  });
});

describe('SessionEnd', () => {
  it('fires once with client_ended on a normal disconnect, even when ended twice', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ transportFactory: () => fake });
    const hooks: Hook[] = [];
    const stops: SessionEndContext[] = [];
    hooks.push(sessionEnd((ctx) => {
      stops.push(ctx);
    }));

    const session = await client.agent({ hooks }).start();
    await session.end();
    await session.end();

    expect(stops).toEqual([
      { event: 'SessionEnd', reason: 'client_ended', detail: null, sessionId: 'sess-fake' },
    ]);
  });

  it('fires with handshake_failed when the session-start POST is rejected', async () => {
    const fake = makeFakeTransport({
      connectError: new SessionStartError(422, 'Unprocessable', {
        code: 'model_unavailable',
        message: 'no such model',
      }),
    });
    const client = new RealtimeClient({ transportFactory: () => fake });
    const hooks: Hook[] = [];
    const stops: SessionEndContext[] = [];
    hooks.push(sessionEnd((ctx) => {
      stops.push(ctx);
    }));

    await expect(client.agent({ hooks }).start()).rejects.toThrow(/no such model/);

    expect(stops).toHaveLength(1);
    expect(stops[0]?.reason).toBe('handshake_failed');
    expect(stops[0]?.detail).toBe('no such model');
  });

  it('fires with transport_error when the transport fails to connect', async () => {
    const fake = makeFakeTransport({ connectError: new Error('ice failed') });
    const client = new RealtimeClient({ transportFactory: () => fake });
    const hooks: Hook[] = [];
    const stops: SessionEndContext[] = [];
    hooks.push(sessionEnd((ctx) => {
      stops.push(ctx);
    }));

    await expect(client.agent({ hooks }).start()).rejects.toThrow(/ice failed/);

    expect(stops).toHaveLength(1);
    expect(stops[0]?.reason).toBe('transport_error');
  });

  it('fires with transport_error on an unsolicited transport close', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ transportFactory: () => fake });
    const hooks: Hook[] = [];
    const stops: SessionEndContext[] = [];
    hooks.push(sessionEnd((ctx) => {
      stops.push(ctx);
    }));

    const session = await client.agent({ hooks }).start();
    fake.emitClose({ reason: 'livekit:server_disconnect' });
    await flushMicrotasks();
    // A late defensive end must not re-fire SessionEnd.
    await session.end();

    expect(stops).toHaveLength(1);
    expect(stops[0]?.reason).toBe('transport_error');
  });

  it('completes an async SessionEnd hook before the terminal lifecycle publish on an unsolicited close', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ transportFactory: () => fake });
    const hooks: Hook[] = [];
    const order: string[] = [];
    hooks.push(sessionEnd(async () => {
      await flushMicrotasks();
      order.push('stop-hook');
    }));

    const session = await client.agent({ hooks }).start();
    session.on('lifecycle', (state) => {
      if (state.kind === 'disconnected') order.push('lifecycle-disconnected');
    });
    fake.emitClose({ reason: 'livekit:server_disconnect' });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(order).toEqual(['stop-hook', 'lifecycle-disconnected']);
  });

  it('fires with server_ended after a session-ended frame and the close that follows', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ transportFactory: () => fake });
    const hooks: Hook[] = [];
    const stops: SessionEndContext[] = [];
    hooks.push(sessionEnd((ctx) => {
      stops.push(ctx);
    }));

    await client.agent({ hooks }).start();
    fake.emitMessage({ type: 'session-ended', reason: 'max_session_duration' });
    fake.emitClose({ reason: 'livekit:server_disconnect' });
    await flushMicrotasks();

    expect(stops).toEqual([
      {
        event: 'SessionEnd',
        reason: 'server_ended',
        detail: 'max_session_duration',
        sessionId: 'sess-fake',
      },
    ]);
  });

  it('fires with server_ended and a normalized detail on a bare deliberate server close', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ transportFactory: () => fake });
    const hooks: Hook[] = [];
    const stops: SessionEndContext[] = [];
    hooks.push(sessionEnd((ctx) => {
      stops.push(ctx);
    }));
    const lifecycles: string[] = [];

    const session = await client.agent({ hooks }).start();
    session.on('lifecycle', (state) => {
      if (state.kind === 'disconnected') {
        lifecycles.push(`${state.disconnectReason}:${state.detail ?? ''}`);
      }
    });
    fake.emitClose({ reason: 'livekit:ROOM_DELETED' });
    await flushMicrotasks();

    expect(stops).toEqual([
      { event: 'SessionEnd', reason: 'server_ended', detail: 'ROOM_DELETED', sessionId: 'sess-fake' },
    ]);
    // The terminal lifecycle publishes (previously skipped on this path).
    expect(lifecycles).toEqual(['server_ended:ROOM_DELETED']);
  });

  it('close() fires client_closed and skips the wire end frame', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ transportFactory: () => fake });
    const hooks: Hook[] = [];
    const stops: SessionEndContext[] = [];
    hooks.push(sessionEnd((ctx) => {
      stops.push(ctx);
    }));

    const session = await client.agent({ hooks }).start();
    await session.close();

    expect(stops).toEqual([
      { event: 'SessionEnd', reason: 'client_closed', detail: null, sessionId: 'sess-fake' },
    ]);
    expect(fake.lastDisconnectOpts()).toEqual({ sendEndFrame: false });
  });

  it('end() still requests the graceful wire end frame', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ transportFactory: () => fake });

    const session = await client.agent({}).start();
    await session.end();

    expect(fake.lastDisconnectOpts()).toEqual({ sendEndFrame: true });
  });
});

describe('user-speech-timeout', () => {
  it('reaches the client as an event, not a hook seam', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ transportFactory: () => fake });
    const events: unknown[] = [];

    const session = await client.agent({}).start();
    session.on('user_speech_timeout', (e) => events.push(e));
    fake.emitMessage({
      type: 'user-speech-timeout',
      session_id: 'sess-1',
      silence_ms: 12000,
      trigger_count: 1,
      max_count: 3,
      action: { type: 'say', text: 'Still there?' },
    });
    await flushMicrotasks();

    expect(events).toEqual([
      {
        sessionId: 'sess-1',
        silenceMs: 12000,
        triggerCount: 1,
        maxCount: 3,
        action: { type: 'say', text: 'Still there?' },
      },
    ]);
  });
});
