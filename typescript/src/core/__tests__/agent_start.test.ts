/** ``client.agent({...}).start({...})`` → what the transport receives:
 *  the wire ``session-config`` body plus the mic-publish flag, and defaults
 *  resolution from ``RealtimeClientOptions.defaults``. Python's
 *  ``tests/test_agent.py`` is the cross-SDK reference. */

import { describe, expect, it, vi } from 'vitest';
import { TextEncoder as NodeTextEncoder, TextDecoder as NodeTextDecoder } from 'util';

if (typeof global.TextEncoder === 'undefined') {
  global.TextEncoder = NodeTextEncoder as typeof global.TextEncoder;
}
if (typeof global.TextDecoder === 'undefined') {
  global.TextDecoder = NodeTextDecoder as typeof global.TextDecoder;
}

import { RealtimeClient } from '../realtime_client';
import { NotReadyError } from '../types';
import {
  inlineAgent,
  makeFakeTransport,
  fakeSessionResponse,
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

describe('RealtimeAgent.start → session-config body', () => {
  it('omits the session block entirely when nothing sets it', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ transportFactory: () => fake });

    await client.agent({ voice: 'Breezy' }).start();

    const config = fake.lastConfig();
    expect(config?.agent).toEqual({
      type: 'inline',
      voice: { name: 'Breezy' },
    });
    expect(config?.session).toBeUndefined();
    expect(fake.lastPublishMicrophone()).toBe(true);
  });

  it('suppresses mic publish for a silent-observer session (publishMicrophone: false)', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ transportFactory: () => fake });

    await client.agent().start({
      publishMicrophone: false,
    });

    expect(fake.lastPublishMicrophone()).toBe(false);
  });

  it('routes persona greeting/noise cancellation and the per-run resume', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ transportFactory: () => fake });

    await client
      .agent({ greeting: 'Welcome back!', audio: { noiseCancellation: true } })
      .start({ resumeSessionId: 'sess-prior' });

    const config = fake.lastConfig();
    expect(config?.agent).toEqual({
      type: 'inline',
      greeting: 'Welcome back!',
      audio: { noise_cancellation: true },
    });
    expect(config?.session).toEqual({
      experimental: { resume_session_id: 'sess-prior' },
    });
  });

  it('carries greeting and noise cancellation like any persona field', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ transportFactory: () => fake });

    await client
      .agent({
        instructions: 'persona',
        voice: 'Puck',
        greeting: 'Hello!',
        audio: { noiseCancellation: true },
      })
      .start();

    const agent = inlineAgent(fake.lastConfig());
    expect(agent?.instructions).toBe('persona');
    expect(agent?.voice).toEqual({ name: 'Puck' });
    expect(agent?.greeting).toBe('Hello!');
    expect(agent?.audio).toEqual({ noise_cancellation: true });
  });

  it('routes a catalog-agent name and inputs onto the tagged agent block', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ transportFactory: () => fake });

    await client.catalogAgent('driver-pay', { inputs: { caller_name: 'Sam' } }).start();

    expect(fake.lastConfig()?.agent).toEqual({
      type: 'catalog',
      name: 'driver-pay',
      inputs: { caller_name: 'Sam' },
    });
  });

  it('parses the resolved-agent echo off the ready frame', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ transportFactory: () => fake });
    const session = await client.catalogAgent('driver-pay').start();
    const readyEvents: unknown[] = [];
    session.on('ready', (e) => readyEvents.push(e));

    fake.emitMessage({
      type: 'ready',
      session_id: 'sess-1',
      agent: { name: 'driver-pay', tools: ['cosmo.web_search', 'lookup'] },
    });

    expect(readyEvents).toHaveLength(1);
    expect((readyEvents[0] as { agent: unknown }).agent).toEqual({
      name: 'driver-pay',
      tools: ['cosmo.web_search', 'lookup'],
    });
  });

  it('reports a null resolved agent for an inline-agent ready frame', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ transportFactory: () => fake });
    const session = await client.agent({ voice: 'Puck' }).start();
    const readyEvents: unknown[] = [];
    session.on('ready', (e) => readyEvents.push(e));

    fake.emitMessage({ type: 'ready', session_id: 'sess-1' });

    expect(readyEvents).toHaveLength(1);
    expect((readyEvents[0] as { agent: unknown }).agent).toBeNull();
  });

  it('sends an explicit noise-cancellation opt-out on the wire', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ transportFactory: () => fake });

    await client.agent({ audio: { noiseCancellation: false } }).start();

    expect(inlineAgent(fake.lastConfig())?.audio).toEqual({
      noise_cancellation: false,
    });
  });

  it('exposes the session id and connect timings once started', async () => {
    const fake = makeFakeTransport({
      sessionResponse: fakeSessionResponse('sess-7', {
        room_name: 'room-7',
        timings: {
          version_check_ms: 1,
          project_check_ms: 2,
          provider_resolve_ms: 3,
          db_insert_ms: 4,
          mint_tokens_ms: 5,
          dispatch_ms: 6,
          total_ms: 7,
        },
      }),
    });
    const client = new RealtimeClient({ transportFactory: () => fake });

    const session = await client.agent().start();

    expect(session.sessionId).toBe('sess-7');
    const timings = session.connectTimings;
    expect(timings?.serverTimings?.total_ms).toBe(7);
    expect(timings?.serverTimings?.version_check_ms).toBe(1);
    // Absent on a backend predating the resolved flow, even when the
    // sibling phases are present.
    expect(timings?.serverTimings?.resolve_ms).toBeUndefined();
    // The real phase computation is pinned in the transport's own suite
    // (``transport/__tests__/session_start.test.ts``); these values come from
    // the fake, so only the plumbing is under test here.
  });

  it('freezes the resolved persona', () => {
    const client = new RealtimeClient({ transportFactory: () => makeFakeTransport() });
    const agent = client.agent({ instructions: 'be helpful', voice: 'Puck' });

    expect(agent.config.instructions).toBe('be helpful');
    expect(agent.config.voice).toBe('Puck');
    expect(Object.isFrozen(agent.config)).toBe(true);
  });

  it('rejects cross-variant fields at the type level', () => {
    const client = new RealtimeClient({ transportFactory: () => makeFakeTransport() });
    // @ts-expect-error — CatalogAgentOptions has no persona parameters
    // (voice is the one sanctioned per-run override; instructions is not)
    void (() => client.catalogAgent('driver-pay', { instructions: 'be terse' }));
    // @ts-expect-error — AgentConfig has no catalog-launch parameters
    void (() => client.agent({ name: 'driver-pay' }));
    // @ts-expect-error — a catalog launch requires the name argument
    void (() => client.catalogAgent());
  });

  it('agents open independent sessions differing in a persona knob', async () => {
    const fakes: FakeTransport[] = [];
    const client = new RealtimeClient({
      transportFactory: () => {
        const fake = makeFakeTransport();
        fakes.push(fake);
        return fake;
      },
    });
    const quiet = await client
      .agent({ instructions: 'shared persona', audio: { noiseCancellation: true } })
      .start();
    await quiet.end();
    await client
      .agent({ instructions: 'shared persona', audio: { noiseCancellation: false } })
      .start();

    expect(fakes).toHaveLength(2);
    expect(inlineAgent(fakes[0]?.lastConfig())?.instructions).toBe('shared persona');
    expect(inlineAgent(fakes[1]?.lastConfig())?.instructions).toBe('shared persona');
    expect(inlineAgent(fakes[0]?.lastConfig())?.audio).toEqual({
      noise_cancellation: true,
    });
    expect(inlineAgent(fakes[1]?.lastConfig())?.audio).toEqual({
      noise_cancellation: false,
    });
  });

  it('runs a second concurrent session instead of rejecting it', async () => {
    const fakes: FakeTransport[] = [];
    const client = new RealtimeClient({
      transportFactory: () => {
        const fake = makeFakeTransport();
        fakes.push(fake);
        return fake;
      },
    });
    const agent = client.agent();

    const first = await agent.start();
    const second = await agent.start();

    expect(fakes).toHaveLength(2);
    expect(first.state.kind).toBe('connected');
    expect(second.state.kind).toBe('connected');

    await first.end();
    expect(first.state.kind).toBe('disconnected');
    expect(second.state.kind).toBe('connected');
    await second.end();
  });
});

describe('parity primitives on the session-config body', () => {
  it('routes the model options into the agent block', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ transportFactory: () => fake });

    await client
      .agent({
        modelOptions: {
          provider: 'gemini',
          temperature: 0.4,
          maxOutputTokens: 2048,
        },
      })
      .start();

    const agent = inlineAgent(fake.lastConfig());
    expect(agent?.model_options).toEqual({
      provider: 'gemini',
      temperature: 0.4,
      max_output_tokens: 2048,
    });
  });

  it('routes server hooks into the agent block', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ transportFactory: () => fake });

    await client
      .agent({
        hooks: [
          {
            trigger: 'user.speech.timeout',
            timeout_seconds: 10,
            action: { type: 'say', text: 'Still there?' },
            max_count: 2,
          },
        ],
      })
      .start();

    const agent = inlineAgent(fake.lastConfig());
    expect(agent?.hooks).toEqual([
      {
        trigger: 'user.speech.timeout',
        timeout_seconds: 10,
        action: { type: 'say', text: 'Still there?' },
        max_count: 2,
      },
    ]);
  });
});

describe('sendActivityEnd', () => {
  it('sends the activity-end frame on a live session', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ transportFactory: () => fake });
    const session = await client.agent().start();
    fake.emitMessage({ type: 'ready', session_id: 'sess-1' });

    await session.sendActivityEnd();

    expect(fake.sent).toContainEqual({ type: 'activity-end' });
  });

  it('rejects when the session is not live', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ transportFactory: () => fake });
    const session = await client.agent().start();
    await session.end();

    await expect(session.sendActivityEnd()).rejects.toBeInstanceOf(NotReadyError);
  });
});
