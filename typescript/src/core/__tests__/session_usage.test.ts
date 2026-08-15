/** session.usage() — the usage-summary REST read. Mirror of the Python SDK's
 *  ``tests/test_usage.py``; that file is the cross-SDK contract. */

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { TextEncoder as NodeTextEncoder, TextDecoder as NodeTextDecoder } from 'util';

if (typeof global.TextEncoder === 'undefined') {
  global.TextEncoder = NodeTextEncoder as typeof global.TextEncoder;
}
if (typeof global.TextDecoder === 'undefined') {
  global.TextDecoder = NodeTextDecoder as typeof global.TextDecoder;
}

import { RealtimeClient } from '../realtime_client';
import { RealtimeSession } from '../session';
import { SessionEngine } from '../session_engine';
import { UsageError } from '../usage';
import { fakeSessionResponse, makeFakeTransport } from './test_helpers';

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

const RECORDED_BODY = {
  status: 'completed',
  usage_status: 'recorded',
  duration_seconds: 121.0,
  turn_count: 7,
  user_speaking_seconds: 41.5,
  agent_speaking_seconds: 63.25,
  provider: 'gemini',
  model: 'gemini-3.1-flash-live-preview',
  tokens: {
    input_tokens: 900,
    output_tokens: 400,
    total_tokens: 1300,
    input_audio_tokens: 700,
    input_text_tokens: 150,
    input_image_tokens: 20,
    input_cached_tokens: 30,
    output_audio_tokens: 350,
    output_text_tokens: 50,
  },
};

// What the server sends while the session is live (or before the detailed
// summary lands): the two statuses, everything else null.
const PENDING_BODY = {
  status: 'active',
  usage_status: 'pending',
  duration_seconds: null,
  turn_count: null,
  user_speaking_seconds: null,
  agent_speaking_seconds: null,
  provider: 'gemini',
  model: null,
  tokens: null,
};

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function errorResponse(status: number, body: unknown): Response {
  return {
    ok: false,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('RealtimeClient.getSessionUsage', () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('GETs the usage path with the credential as Bearer and camelCases the result', async () => {
    fetchMock.mockResolvedValue(okResponse(RECORDED_BODY));
    const client = new RealtimeClient({ apiKey: 'sk-secret' });

    const usage = await client.getSessionUsage('sess-1');

    expect(usage).toEqual({
      status: 'completed',
      usageStatus: 'recorded',
      durationSeconds: 121.0,
      turnCount: 7,
      userSpeakingSeconds: 41.5,
      agentSpeakingSeconds: 63.25,
      provider: 'gemini',
      model: 'gemini-3.1-flash-live-preview',
      tokens: {
        inputTokens: 900,
        outputTokens: 400,
        totalTokens: 1300,
        inputAudioTokens: 700,
        inputTextTokens: 150,
        inputImageTokens: 20,
        inputCachedTokens: 30,
        outputAudioTokens: 350,
        outputTextTokens: 50,
      },
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.com/api/v1/external/sessions/sess-1/usage');
    expect(init.method).toBe('GET');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer sk-secret' });
  });

  it('parses a pending summary', async () => {
    fetchMock.mockResolvedValue(okResponse(PENDING_BODY));
    const client = new RealtimeClient({ apiKey: 'sk-secret' });

    const usage = await client.getSessionUsage('sess-1');

    expect(usage.status).toBe('active');
    expect(usage.usageStatus).toBe('pending');
    expect(usage.durationSeconds).toBeNull();
    expect(usage.tokens).toBeNull();
  });

  it('surfaces the server slug as the UsageError code', async () => {
    fetchMock.mockResolvedValue(
      errorResponse(404, {
        error: {
          type: 'api_error',
          code: 'not_found',
          message: 'voice session sess-1 not found',
        },
      }),
    );
    const client = new RealtimeClient({ apiKey: 'sk-secret' });

    const err = await client.getSessionUsage('sess-1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UsageError);
    expect((err as UsageError).code).toBe('not_found');
    expect((err as UsageError).message).toContain('not found');
  });

  it('maps a malformed success to invalid_response', async () => {
    fetchMock.mockResolvedValue(okResponse({ unexpected: 'shape' }));
    const client = new RealtimeClient({ apiKey: 'sk-secret' });

    const err = await client.getSessionUsage('sess-1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UsageError);
    expect((err as UsageError).code).toBe('invalid_response');
  });

  it('maps a transport failure', async () => {
    fetchMock.mockRejectedValue(new Error('boom'));
    const client = new RealtimeClient({ apiKey: 'sk-secret' });

    const err = await client.getSessionUsage('sess-1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UsageError);
    expect((err as UsageError).code).toBe('transport_error');
  });
});

describe('RealtimeSession.usage', () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('reads this session id after the session ends', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({
      apiKey: 'sk-secret',
      transportFactory: () => fake,
    });
    const session = await client.agent().start();

    await session.end();
    // The engine drops its session id at teardown; the id the session bound
    // at start is what keeps usage() working after the call.
    expect(client.getSessionId()).toBeNull();

    fetchMock.mockResolvedValue(okResponse(RECORDED_BODY));
    const usage = await session.usage();

    expect(usage.usageStatus).toBe('recorded');
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://api.example.com/api/v1/external/sessions/sess-fake/usage',
    );
  });

  it('keeps its own id when a later session starts on the same client', async () => {
    // An end() the caller never awaited opens a window: teardown has
    // dropped the engine's connection, so the next start is admitted, but
    // the disconnected event that unsubscribes this wrapper has not fired.
    // A transport whose disconnect blocks holds that window open.
    let releaseDisconnect = (): void => {};
    const blocked = new Promise<void>((resolve) => {
      releaseDisconnect = resolve;
    });
    const ids = ['sess-first', 'sess-second'];
    let started = 0;
    const client = new RealtimeClient({
      apiKey: 'sk-secret',
      transportFactory: () => {
        const id = ids[started++] ?? 'sess-extra';
        const transport = makeFakeTransport({
          sessionResponse: fakeSessionResponse(id),
        });
        return id === 'sess-first'
          ? { ...transport, disconnect: async (): Promise<void> => blocked }
          : transport;
      },
    });
    const first = await client.agent().start();

    const ending = first.end();
    for (let i = 0; i < 50 && client.getSessionId() !== null; i++) {
      await Promise.resolve();
    }
    const second = await client.agent().start();
    expect(second.sessionId).toBe('sess-second');
    releaseDisconnect();
    await ending;

    fetchMock.mockResolvedValue(okResponse(RECORDED_BODY));
    await first.usage();

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://api.example.com/api/v1/external/sessions/sess-first/usage',
    );
  });

  it('rejects with not_started when the session never started', async () => {
    const engine = new SessionEngine({
      createTransport: () => makeFakeTransport(),
      startUrl: () => 'https://api.example.com/api/v1/external/realtime/session/start',
      dialUrl: (sessionId) =>
        `https://api.example.com/api/v1/external/sessions/${sessionId}/dial`,
      usageUrl: (sessionId) =>
        `https://api.example.com/api/v1/external/sessions/${sessionId}/usage`,
      resolveAuthHeaders: async () => ({}),
      onStartUnauthorized: () => {},
      defaultAudioElement: () => null,
    });
    const session = new RealtimeSession(engine);

    const err = await session.usage().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UsageError);
    expect((err as UsageError).code).toBe('not_started');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
