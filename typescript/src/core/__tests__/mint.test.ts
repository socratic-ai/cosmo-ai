/** mintToken (end-user JWT flow) + the apiKey/token credential split.
 *  Mirror of the Python SDK's ``tests/test_mint.py`` — that file is the
 *  cross-SDK contract for credential construction and mint semantics. */

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { TextEncoder as NodeTextEncoder, TextDecoder as NodeTextDecoder } from 'util';

if (typeof global.TextEncoder === 'undefined') {
  global.TextEncoder = NodeTextEncoder as typeof global.TextEncoder;
}
if (typeof global.TextDecoder === 'undefined') {
  global.TextDecoder = NodeTextDecoder as typeof global.TextDecoder;
}

import { RealtimeClient } from '../realtime_client';
import { SDK_NAME, SDK_VERSION } from '../../constants';

const SDK_IDENTITY = `${SDK_NAME}/${SDK_VERSION}`;
import { CredentialError, MintTokenError } from '../auth';
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

const BASE_URL = 'https://api.example.com';
const PAGE_ORIGIN = 'https://app.example.com';

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

/** Stub a browser ``window.location.origin``; returns the restore. */
function stubPageOrigin(origin: string): () => void {
  const globals = globalThis as { window?: unknown };
  const had = 'window' in globals;
  const previous = globals.window;
  globals.window = { location: { origin } };
  return () => {
    if (had) globals.window = previous;
    else delete globals.window;
  };
}

function errorResponse(status: number, body: unknown): Response {
  return {
    ok: false,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('RealtimeClient credential construction', () => {
  it('rejects providing both apiKey and token', () => {
    expect(
      () => new RealtimeClient({ apiKey: 'sk-secret', token: 'end-user-jwt' }),
    ).toThrow(CredentialError);
  });

  it('accepts exactly one credential, or none (same-origin cookie flow)', () => {
    expect(() => new RealtimeClient({ apiKey: 'sk-secret' })).not.toThrow();
    expect(() => new RealtimeClient({ token: 'end-user-jwt' })).not.toThrow();
    expect(() => new RealtimeClient()).not.toThrow();
  });

  it('never exposes the credential through serialization', () => {
    const client = new RealtimeClient({ apiKey: 'sk-secret' });
    expect(JSON.stringify(client)).not.toContain('sk-secret');
    expect(Object.entries(client).flat().join()).not.toContain('sk-secret');
  });
});

describe('RealtimeClient.mintToken', () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('POSTs external_user_id with the apiKey as Bearer and returns the minted token', async () => {
    fetchMock.mockResolvedValue(
      okResponse({ jwt: 'eyJabc', expires_at: '2026-06-22T18:00:00Z' }),
    );
    const client = new RealtimeClient({ apiKey: 'sk-secret' });

    const minted = await client.mintToken('user-123');

    expect(minted.jwt).toBe('eyJabc');
    expect(minted.expiresAt.getUTCFullYear()).toBe(2026);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.com/api/v1/external/auth/token');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer sk-secret',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(init.body)).toEqual({ external_user_id: 'user-123' });
  });

  it('serializes ttlSeconds as ttl_seconds and omits it when not given', async () => {
    fetchMock.mockResolvedValue(
      okResponse({ jwt: 'eyJabc', expires_at: '2026-06-22T18:00:00Z' }),
    );
    const client = new RealtimeClient({ apiKey: 'sk-secret' });

    await client.mintToken('user-123', { ttlSeconds: 300 });
    await client.mintToken('user-123');

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      external_user_id: 'user-123',
      ttl_seconds: 300,
    });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      external_user_id: 'user-123',
    });
  });

  it('rejects with no_api_key on a token-credentialed client without reaching the network', async () => {
    const client = new RealtimeClient({ token: 'end-user-jwt' });

    const err = await client.mintToken('user-123').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MintTokenError);
    expect((err as MintTokenError).code).toBe('no_api_key');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects with no_api_key on a credential-less (cookie flow) client', async () => {
    const client = new RealtimeClient({});

    await expect(client.mintToken('user-123')).rejects.toMatchObject({ code: 'no_api_key' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces a server rejection code from the internal detail envelope', async () => {
    fetchMock.mockResolvedValue(
      errorResponse(403, { detail: { code: 'forbidden', message: 'nope' } }),
    );
    const client = new RealtimeClient({ apiKey: 'sk-secret' });

    const err = await client.mintToken('user-123').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MintTokenError);
    expect((err as MintTokenError).code).toBe('forbidden');
    expect((err as MintTokenError).message).toBe('nope');
  });

  it('surfaces a server rejection code from the external error envelope', async () => {
    fetchMock.mockResolvedValue(
      errorResponse(429, {
        error: { type: 'api_error', message: { code: 'rate_limited', message: 'Slow down.' } },
      }),
    );
    const client = new RealtimeClient({ apiKey: 'sk-secret' });

    await expect(client.mintToken('user-123')).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('maps a network failure to transport_error', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const client = new RealtimeClient({ apiKey: 'sk-secret' });

    await expect(client.mintToken('user-123')).rejects.toMatchObject({
      code: 'transport_error',
      message: 'Failed to fetch',
    });
  });

  it.each([
    ['missing jwt', { expires_at: '2026-06-22T18:00:00Z' }],
    ['empty jwt', { jwt: '', expires_at: '2026-06-22T18:00:00Z' }],
    ['missing expires_at', { jwt: 'eyJabc' }],
    ['unparseable expires_at', { jwt: 'eyJabc', expires_at: 'not-a-date' }],
    ['unexpected shape', { unexpected: 'shape' }],
  ])('raises invalid_response when a 200 body has %s', async (_label, body) => {
    fetchMock.mockResolvedValue(okResponse(body));
    const client = new RealtimeClient({ apiKey: 'sk-secret' });

    await expect(client.mintToken('user-123')).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });
});

describe('credential on session-start and merged getAuthHeaders', () => {
  function makeCapturingTransport(): RealtimeTransport & {
    resolvedHeaders: () => Promise<Record<string, string>> | undefined;
    lastOpts: () => RealtimeConnectOptions | undefined;
  } {
    let headersPromise: Promise<Record<string, string>> | undefined;
    let captured: RealtimeConnectOptions | undefined;
    return {
      connect: async (opts: RealtimeConnectOptions): Promise<void> => {
        captured = opts;
        headersPromise = opts.getAuthHeaders ? Promise.resolve(opts.getAuthHeaders()) : undefined;
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
      resolvedHeaders: () => headersPromise,
      lastOpts: () => captured,
    };
  }

  it('attaches the credential as Bearer to the session-start POST', async () => {
    const fake = makeCapturingTransport();
    const client = new RealtimeClient({
      token: 'end-user-jwt',
      transportFactory: () => fake,
    });

    await client.agent().start();

    await expect(fake.resolvedHeaders()).resolves.toEqual({
      'X-Cosmo-SDK': SDK_IDENTITY,
      Authorization: 'Bearer end-user-jwt',
    });
  });

  it('merges getAuthHeaders extras and lets the credential win on Authorization', async () => {
    const fake = makeCapturingTransport();
    const client = new RealtimeClient({
      token: 'end-user-jwt',
      getAuthHeaders: () => ({ 'x-custom': '1', Authorization: 'Bearer stale' }),
      transportFactory: () => fake,
    });

    await client.agent().start();

    await expect(fake.resolvedHeaders()).resolves.toEqual({
      'X-Cosmo-SDK': SDK_IDENTITY,
      'x-custom': '1',
      Authorization: 'Bearer end-user-jwt',
    });
  });

  it('replaces a lower-case authorization header instead of duplicating it', async () => {
    const fake = makeCapturingTransport();
    const client = new RealtimeClient({
      token: 'end-user-jwt',
      getAuthHeaders: () => ({ 'x-custom': '1', authorization: 'Bearer stale' }),
      transportFactory: () => fake,
    });

    await client.agent().start();

    await expect(fake.resolvedHeaders()).resolves.toEqual({
      'X-Cosmo-SDK': SDK_IDENTITY,
      'x-custom': '1',
      Authorization: 'Bearer end-user-jwt',
    });
  });

  it('keeps the host-supplied header shape when no credential is configured', async () => {
    const fake = makeCapturingTransport();
    const client = new RealtimeClient({
      getAuthHeaders: () => ({ 'x-cosmo-workspace-id': 'ws-1' }),
      transportFactory: () => fake,
    });

    await client.agent().start();

    await expect(fake.resolvedHeaders()).resolves.toEqual({
      'X-Cosmo-SDK': SDK_IDENTITY,
      'x-cosmo-workspace-id': 'ws-1',
    });
  });

  it('targets the external session-start URL composed from baseUrl', async () => {
    const fake = makeCapturingTransport();
    const client = new RealtimeClient({
      token: 'end-user-jwt',
      transportFactory: () => fake,
    });

    await client.agent().start();

    expect(fake.lastOpts()?.sessionStartUrl).toBe(
      'https://api.example.com/api/v1/external/realtime/session/start',
    );
  });

  it('starts an apiKey session against the resolved backend', async () => {
    const fake = makeCapturingTransport();
    const client = new RealtimeClient({ apiKey: 'sk-secret', transportFactory: () => fake });

    await client.agent().start();

    expect(fake.lastOpts()?.sessionStartUrl).toBe(
      'https://api.example.com/api/v1/external/realtime/session/start',
    );
    await expect(fake.resolvedHeaders()).resolves.toEqual({
      'X-Cosmo-SDK': SDK_IDENTITY,
      Authorization: 'Bearer sk-secret',
    });
  });

  it('hands the transport the session-config body with no init wrapper', async () => {
    const fake = makeCapturingTransport();
    const client = new RealtimeClient({
      token: 'end-user-jwt',
      transportFactory: () => fake,
    });

    await client.agent({ voice: 'Breezy' }).start();

    const config = fake.lastOpts()?.config;
    expect(config?.type).toBe('session-config');
    expect(config).not.toHaveProperty('init');
  });
});
