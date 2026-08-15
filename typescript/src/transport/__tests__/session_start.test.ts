// @vitest-environment jsdom
/**
 * LiveKitTransport.connect: the session-start POST (raw ``session-config``
 * body, bearer headers, no cookie credentials) and the ``bind-input``
 * voice-binding frame that follows mic publish.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { TextEncoder as NodeTextEncoder, TextDecoder as NodeTextDecoder } from 'util';

if (typeof global.TextEncoder === 'undefined') {
  global.TextEncoder = NodeTextEncoder as typeof global.TextEncoder;
}
if (typeof global.TextDecoder === 'undefined') {
  global.TextDecoder = NodeTextDecoder as typeof global.TextDecoder;
}

import { LiveKitTransport } from '../livekit_transport';
import {
  SessionBusyError,
  SessionEntitlementError,
  SessionStartError,
  SessionStartTransportError,
} from '../session_start_error';
import type { SessionConfig } from '../../wire/types.gen';

const { setMic, roomConnect, publishData, mockHandlers } = vi.hoisted(() => ({
  setMic: vi.fn().mockResolvedValue(undefined),
  roomConnect: vi.fn().mockResolvedValue(undefined),
  publishData: vi.fn().mockResolvedValue(undefined),
  mockHandlers: {} as Record<string, (...args: unknown[]) => void>,
}));

vi.mock('livekit-client', () => {
  class Room {
    state = 'connected';
    localParticipant = { setMicrophoneEnabled: setMic, publishData };
    on(event: string, cb: (...args: unknown[]) => void) {
      mockHandlers[event] = cb;
      return this;
    }
    connect = roomConnect;
    async disconnect() {}
  }
  return {
    Room,
    RoomEvent: {
      DataReceived: 'dataReceived',
      TrackSubscribed: 'trackSubscribed',
      TrackUnsubscribed: 'trackUnsubscribed',
      Disconnected: 'disconnected',
      Reconnecting: 'reconnecting',
      Reconnected: 'reconnected',
      ParticipantDisconnected: 'participantDisconnected',
    },
    Track: { Kind: { Audio: 'audio' }, Source: { Microphone: 'microphone' } },
    ConnectionState: { Connected: 'connected' },
    LocalVideoTrack: class {},
    RemoteTrack: class {},
  };
});

const START_URL = 'https://api.example.com/api/v1/external/realtime/session/start';

const CONFIG: SessionConfig = {
  type: 'session-config',
  agent: { type: 'inline', voice: { name: 'Breezy' } },
};

const SESSION_RESPONSE = {
  livekit_url: 'wss://lk.example',
  token: 'lk-jwt',
  room_name: 'room-1',
  session_id: 'sess-1',
  timings: {
    version_check_ms: 1,
    project_check_ms: 2,
    provider_resolve_ms: 3,
    db_insert_ms: 4,
    mint_tokens_ms: 5,
    dispatch_ms: 6,
    total_ms: 7,
  },
};

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function publishedFrames(): Array<{ type: string }> {
  return publishData.mock.calls.map(
    ([bytes]) => JSON.parse(new TextDecoder().decode(bytes as Uint8Array)) as { type: string },
  );
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

let fetchMock: Mock;

beforeEach(() => {
  setMic.mockClear();
  roomConnect.mockClear();
  publishData.mockClear();
  for (const key of Object.keys(mockHandlers)) delete mockHandlers[key];
  fetchMock = vi.fn().mockResolvedValue(okResponse(SESSION_RESPONSE));
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe('LiveKitTransport session-start POST', () => {
  it('POSTs the session-config as the raw JSON body with Content-Type and auth headers', async () => {
    const t = new LiveKitTransport();
    await t.connect({
      config: CONFIG,
      sessionStartUrl: START_URL,
      getAuthHeaders: () => ({ Authorization: 'Bearer end-user-jwt' }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(START_URL);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: 'Bearer end-user-jwt',
    });
    expect(init.body).toBe(JSON.stringify(CONFIG));
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.type).toBe('session-config');
    expect(body).not.toHaveProperty('init');
    // Bearer-authenticated endpoint — the transport must not opt into
    // cookie credentials (would force Access-Control-Allow-Credentials
    // on cross-origin embedders for no benefit).
    expect(init.credentials).toBeUndefined();
  });

  it('resolves the livekit fields and reports the minted session id', async () => {
    const onSessionStarted = vi.fn();
    const t = new LiveKitTransport();
    await t.connect({ config: CONFIG, sessionStartUrl: START_URL, onSessionStarted });

    expect(roomConnect).toHaveBeenCalledWith('wss://lk.example', 'lk-jwt');
    expect(onSessionStarted).toHaveBeenCalledWith('sess-1');
  });

  it('attributes each connect phase to the leg that spent it', async () => {
    // Give each leg a distinguishable cost so a phase attributed to the wrong
    // leg — or a total that does not span the whole connect — fails here.
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    fetchMock.mockImplementation(async () => {
      await delay(60);
      return okResponse(SESSION_RESPONSE);
    });
    roomConnect.mockImplementation(async () => {
      await delay(30);
    });
    setMic.mockImplementation(async () => {
      await delay(15);
    });

    const onConnectTimings = vi.fn();
    const t = new LiveKitTransport();
    await t.connect({ config: CONFIG, sessionStartUrl: START_URL, onConnectTimings });

    expect(onConnectTimings).toHaveBeenCalledTimes(1);
    const timings = onConnectTimings.mock.calls[0][0];

    // Ordering, not exact values — timers are not precise enough to pin ms.
    expect(timings.wsMs).toBeGreaterThan(timings.roomMs);
    expect(timings.roomMs).toBeGreaterThan(timings.micMs);
    expect(timings.micMs).toBeGreaterThan(0);
    // No prepared-room fast path here, so the phases account for the whole
    // connect with nothing unattributed.
    expect(timings.totalConnectMs).toBeCloseTo(
      timings.wsMs + timings.roomMs + timings.micMs,
      0,
    );
    // The server's own breakdown rides through rather than being dropped at
    // the transport boundary.
    expect(timings.serverTimings).toEqual(SESSION_RESPONSE.timings);
  });

  it('reports a zero mic phase when the session publishes no microphone', async () => {
    const onConnectTimings = vi.fn();
    const t = new LiveKitTransport();
    await t.connect({
      config: CONFIG,
      sessionStartUrl: START_URL,
      publishMicrophone: false,
      onConnectTimings,
    });

    expect(setMic).not.toHaveBeenCalled();
    expect(onConnectTimings.mock.calls[0][0].micMs).toBe(0);
  });

  it('throws SessionStartError carrying the server detail on a rejection', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 402,
      statusText: 'Payment Required',
      headers: new Headers(),
      json: async () => ({
        error: { type: 'api_error', code: 'free_minutes_exhausted', message: 'Free minutes exhausted.' },
      }),
    } as unknown as Response);
    const t = new LiveKitTransport();

    const err = await t
      .connect({ config: CONFIG, sessionStartUrl: START_URL })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SessionEntitlementError);
    expect((err as SessionStartError).status).toBe(402);
    expect((err as SessionStartError).detail).toEqual({
      code: 'free_minutes_exhausted',
      message: 'Free minutes exhausted.',
    });
    expect(roomConnect).not.toHaveBeenCalled();
  });

  it('throws SessionBusyError with the Retry-After delta on a 429', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      headers: new Headers({ 'retry-after': '15' }),
      json: async () => ({
        error: {
          type: 'api_error',
          code: 'concurrent_session_limit',
          message: 'This workspace already has 2 active sessions (limit 2).',
          limit: 2,
          active: 2,
        },
      }),
    } as unknown as Response);
    const t = new LiveKitTransport();

    const err = await t
      .connect({ config: CONFIG, sessionStartUrl: START_URL })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SessionBusyError);
    expect((err as SessionBusyError).retryAfterSeconds).toBe(15);
    expect((err as SessionBusyError).detail).toMatchObject({
      code: 'concurrent_session_limit',
      limit: 2,
      active: 2,
    });
    expect(roomConnect).not.toHaveBeenCalled();
  });

  it('wraps a fetch that never reached the server, keeping it off the handshake path', async () => {
    const cause = new TypeError('Failed to fetch');
    fetchMock.mockRejectedValue(cause);
    const t = new LiveKitTransport();

    const err = await t
      .connect({ config: CONFIG, sessionStartUrl: START_URL })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SessionStartTransportError);
    expect((err as SessionStartTransportError).code).toBe('transport_error');
    expect((err as Error).cause).toBe(cause);
    // The page (jsdom's origin) and START_URL differ, so the bare
    // ``Failed to fetch`` is annotated with the cross-origin possibility.
    expect((err as Error).message).toContain('cross-origin');
    expect((err as Error).message).toContain('https://api.example.com');
    // A pre-response failure is NOT a rejection by the server: RealtimeClient
    // branches on this type to report ``handshake_failed`` instead of
    // ``transport_error``.
    expect(err).not.toBeInstanceOf(SessionStartError);
    expect(roomConnect).not.toHaveBeenCalled();
  });
});

describe('LiveKitTransport bind-input', () => {
  it('publishes a bind-input frame after the mic publish', async () => {
    const t = new LiveKitTransport();
    await t.connect({ config: CONFIG, sessionStartUrl: START_URL });

    expect(setMic).toHaveBeenCalledWith(true);
    const bindFrames = publishedFrames().filter((f) => f.type === 'bind-input');
    expect(bindFrames).toEqual([{ type: 'bind-input' }]);
  });

  it('skips mic publish and bind-input when publishMicrophone is false', async () => {
    const t = new LiveKitTransport();
    await t.connect({ config: CONFIG, sessionStartUrl: START_URL, publishMicrophone: false });

    expect(setMic).not.toHaveBeenCalled();
    expect(publishedFrames().filter((f) => f.type === 'bind-input')).toHaveLength(0);
  });

  it('re-sends bind-input when the room reconnects', async () => {
    const t = new LiveKitTransport();
    await t.connect({ config: CONFIG, sessionStartUrl: START_URL });
    publishData.mockClear();

    mockHandlers['reconnected']?.();
    await flushAsync();

    expect(publishedFrames().filter((f) => f.type === 'bind-input')).toHaveLength(1);
  });

  it('does not re-send bind-input on reconnect when the mic was never published', async () => {
    const t = new LiveKitTransport();
    await t.connect({ config: CONFIG, sessionStartUrl: START_URL, publishMicrophone: false });
    publishData.mockClear();

    mockHandlers['reconnected']?.();
    await flushAsync();

    expect(publishedFrames().filter((f) => f.type === 'bind-input')).toHaveLength(0);
  });
});
