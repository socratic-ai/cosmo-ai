/** verify() — the free credential preflight. Mirror of the Python SDK's
 *  ``tests/test_verify.py``; that file is the cross-SDK contract. */

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { TextEncoder as NodeTextEncoder, TextDecoder as NodeTextDecoder } from 'util';
import { SDK_NAME, SDK_VERSION } from '../../constants';

if (typeof global.TextEncoder === 'undefined') {
  global.TextEncoder = NodeTextEncoder as typeof global.TextEncoder;
}
if (typeof global.TextDecoder === 'undefined') {
  global.TextDecoder = NodeTextDecoder as typeof global.TextDecoder;
}

import { RealtimeClient } from '../realtime_client';
import { VerifyError } from '../verify';

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

const OK_BODY = {
  credential: 'api_key',
  workspace: { name: 'Acme', slug: 'acme' },
  scopes: ['realtime:use'],
  can_start_sessions: true,
  realtime_voice_available: true,
  external_user_id: null,
};

// What the server sends a minted token: ``workspace`` serialized as null.
const TOKEN_BODY = {
  credential: 'user_token',
  workspace: null,
  scopes: ['realtime:use'],
  can_start_sessions: true,
  realtime_voice_available: true,
  external_user_id: 'user-123',
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

describe('RealtimeClient.verify', () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('GETs the preflight with the credential as Bearer and camelCases the result', async () => {
    fetchMock.mockResolvedValue(okResponse(OK_BODY));
    const client = new RealtimeClient({ apiKey: 'sk-secret' });

    const info = await client.verify();

    expect(info).toEqual({
      credential: 'api_key',
      workspace: { name: 'Acme', slug: 'acme' },
      scopes: ['realtime:use'],
      canStartSessions: true,
      realtimeVoiceAvailable: true,
      externalUserId: null,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.com/api/v1/external/realtime/verify');
    expect(init.method).toBe('GET');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer sk-secret',
      'X-Cosmo-SDK': `${SDK_NAME}/${SDK_VERSION}`,
    });
  });

  it('works with a minted token credential, reporting its end user but no workspace', async () => {
    fetchMock.mockResolvedValue(okResponse(TOKEN_BODY));
    const client = new RealtimeClient({ token: 'end-user-jwt' });

    const info = await client.verify();

    expect(info.credential).toBe('user_token');
    expect(info.externalUserId).toBe('user-123');
    expect(info.workspace).toBeNull();
    expect(info.canStartSessions).toBe(true);
  });

  it('reports an under-scoped credential without rejecting', async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        ...OK_BODY,
        scopes: ['chat:read'],
        can_start_sessions: false,
        realtime_voice_available: false,
      }),
    );
    const client = new RealtimeClient({ apiKey: 'sk-secret' });

    const info = await client.verify();

    expect(info.canStartSessions).toBe(false);
    expect(info.realtimeVoiceAvailable).toBe(false);
  });

  it('surfaces a server rejection code', async () => {
    fetchMock.mockResolvedValue(
      errorResponse(401, { detail: { code: 'auth_failed', message: 'bad key' } }),
    );
    const client = new RealtimeClient({ apiKey: 'sk-secret' });

    const err = await client.verify().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(VerifyError);
    expect((err as VerifyError).code).toBe('auth_failed');
  });

  it('maps a network failure to transport_error', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const client = new RealtimeClient({ apiKey: 'sk-secret' });

    await expect(client.verify()).rejects.toMatchObject({ code: 'transport_error' });
  });

  it.each([
    ['not an object', 'nope'],
    ['workspace missing its slug', { ...OK_BODY, workspace: { name: 'Acme' } }],
    ['non-boolean can_start_sessions', { ...OK_BODY, can_start_sessions: 'yes' }],
    ['non-string scope', { ...OK_BODY, scopes: [1] }],
  ])('rejects a malformed success body (%s)', async (_label, body) => {
    fetchMock.mockResolvedValue(okResponse(body));
    const client = new RealtimeClient({ apiKey: 'sk-secret' });

    await expect(client.verify()).rejects.toMatchObject({ code: 'invalid_response' });
  });
});
