import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { TextEncoder as NodeTextEncoder, TextDecoder as NodeTextDecoder } from 'util';

if (typeof global.TextEncoder === 'undefined') {
  global.TextEncoder = NodeTextEncoder as typeof global.TextEncoder;
}
if (typeof global.TextDecoder === 'undefined') {
  global.TextDecoder = NodeTextDecoder as typeof global.TextDecoder;
}

import { RealtimeClient } from '../realtime_client';
import { NotReadyError } from '../types';
import { DialError } from '../../transport/dial';
import type { RealtimeConnectOptions, RealtimeTransport } from '../../transport/types';

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

/** Fake transport that publishes a server-minted session id on connect (the
 *  real transport fires this the instant the session-start POST returns) so
 *  ``dial()`` has a live session id to target. */
function makeFakeTransport(sessionId = 'sess-123'): RealtimeTransport {
  return {
    connect: async (opts: RealtimeConnectOptions): Promise<void> => {
      opts.onSessionStarted?.(sessionId);
    },
    disconnect: async (): Promise<void> => {},
    send: async (): Promise<void> => {},
    setMicMuted: async (): Promise<void> => {},
    getInputStream: () => null,
    getOutputAudioElement: () => null,
    attachAudioElement: () => {},
    onMessage: () => () => {},
    onClose: () => () => {},
    onReconnecting: () => () => {},
    onReconnected: () => () => {},
  };
}

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function errorResponse(status: number, body: unknown): Response {
  return {
    ok: false,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

const BASE_URL = 'https://api.example.com';
const NUMBER = '+14155550199';

describe('RealtimeClient.dial', () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  async function connectedClient(
    options: ConstructorParameters<typeof RealtimeClient>[0] = {},
  ): Promise<RealtimeClient> {
    const client = new RealtimeClient({
      transportFactory: () => makeFakeTransport(),
      ...options,
    });
    await client.agent().start();
    return client;
  }

  it('POSTs to the baseUrl-composed dial URL with auth headers + body and returns dialId', async () => {
    fetchMock.mockResolvedValue(okResponse({ dial_id: 'dial-789' }));
    const client = await connectedClient({
      getAuthHeaders: () => ({ Authorization: 'Bearer tok' }),
    });

    const result = await client.dial(NUMBER);

    expect(result).toEqual({ dialId: 'dial-789' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.com/api/v1/external/realtime/session/sess-123/dial');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer tok',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(init.body)).toEqual({ phone_number: NUMBER });
  });

  it('includes caller_number in the body when a caller-ID is passed', async () => {
    fetchMock.mockResolvedValue(okResponse({ dial_id: 'dial-cid' }));
    const client = await connectedClient({});

    await client.dial(NUMBER, '+12139458610');

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      phone_number: NUMBER,
      caller_number: '+12139458610',
    });
  });

  it('fast-fails a malformed caller-ID locally without hitting the network', async () => {
    const client = await connectedClient({});

    await expect(client.dial(NUMBER, '1234')).rejects.toMatchObject({
      code: 'invalid_phone_number',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('awaits an async getAuthHeaders and applies the resolved headers', async () => {
    fetchMock.mockResolvedValue(okResponse({ dial_id: 'dial-async' }));
    const client = await connectedClient({
      getAuthHeaders: async () => ({ Authorization: 'Bearer async-tok' }),
    });

    const result = await client.dial(NUMBER);

    expect(result).toEqual({ dialId: 'dial-async' });
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      Authorization: 'Bearer async-tok',
      'Content-Type': 'application/json',
    });
  });

  it('maps a network failure to DialError(transport_error)', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const client = await connectedClient({});

    const err = await client.dial(NUMBER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DialError);
    expect((err as DialError).code).toBe('transport_error');
    expect((err as DialError).message).toBe('Failed to fetch');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fast-fails a malformed number locally without hitting the network', async () => {
    const client = await connectedClient({});

    await expect(client.dial('1234')).rejects.toMatchObject({
      code: 'invalid_phone_number',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces a server rejection from the external error envelope as DialError', async () => {
    fetchMock.mockResolvedValue(
      errorResponse(403, {
        error: { type: 'api_error', message: { code: 'phone_calls_disabled', message: 'Not enabled.' } },
      }),
    );
    const client = await connectedClient({});

    const err = await client.dial(NUMBER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DialError);
    expect((err as DialError).code).toBe('phone_calls_disabled');
    expect((err as DialError).message).toBe('Not enabled.');
  });

  it('surfaces a server rejection from the internal detail envelope', async () => {
    fetchMock.mockResolvedValue(
      errorResponse(409, { detail: { code: 'session_not_live', message: 'Session has ended.' } }),
    );
    const client = await connectedClient({});

    await expect(client.dial(NUMBER)).rejects.toMatchObject({ code: 'session_not_live' });
  });

  it('raises invalid_response when a 200 body is missing dial_id', async () => {
    fetchMock.mockResolvedValue(okResponse({ unexpected: true }));
    const client = await connectedClient({});

    await expect(client.dial(NUMBER)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('throws NotReadyError when no session has started', async () => {
    const client = new RealtimeClient({});

    await expect(client.dial(NUMBER)).rejects.toBeInstanceOf(NotReadyError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('clears the session id on disconnect so a later dial is not_ready', async () => {
    fetchMock.mockResolvedValue(okResponse({ dial_id: 'dial-1' }));
    const client = await connectedClient({});
    await client.disconnect();

    await expect(client.dial(NUMBER)).rejects.toBeInstanceOf(NotReadyError);
  });
});
