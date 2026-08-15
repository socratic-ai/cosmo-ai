// @vitest-environment jsdom
/**
 * LiveKitTransport RPC registration ordering: a method registered before
 * ``connect`` is parked and bound onto the room BEFORE ``room.connect``, so
 * a tool invocation arriving in the join window finds its handler instead of
 * "method not found" (the join→register startup race).
 */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { LiveKitTransport } from '../livekit_transport';
import type { SessionConfig } from '../../wire/types.gen';

const { registerRpcMethod, unregisterRpcMethod, roomConnect, setMic, publishData, remoteParticipants } =
  vi.hoisted(() => ({
    registerRpcMethod: vi.fn(),
    unregisterRpcMethod: vi.fn(),
    roomConnect: vi.fn().mockResolvedValue(undefined),
    setMic: vi.fn().mockResolvedValue(undefined),
    publishData: vi.fn().mockResolvedValue(undefined),
    remoteParticipants: new Map<string, { identity: string; kind: string }>(),
  }));

vi.mock('livekit-client', () => {
  class Room {
    state = 'connected';
    remoteParticipants = remoteParticipants;
    localParticipant = {
      setMicrophoneEnabled: setMic,
      publishData,
      registerRpcMethod,
      unregisterRpcMethod,
    };
    on(_event: string, _cb: (...args: unknown[]) => void) {
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
    ParticipantKind: { AGENT: 'agent', STANDARD: 'standard' },
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
};

let fetchMock: Mock;

beforeEach(() => {
  registerRpcMethod.mockClear();
  unregisterRpcMethod.mockClear();
  roomConnect.mockClear();
  setMic.mockClear();
  publishData.mockClear();
  remoteParticipants.clear();
  fetchMock = vi
    .fn()
    .mockResolvedValue({ ok: true, status: 200, json: async () => SESSION_RESPONSE } as unknown as Response);
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe('LiveKitTransport pre-connect RPC registration', () => {
  it('parks a pre-connect registration and binds it before room.connect', async () => {
    const t = new LiveKitTransport();
    const handler = vi.fn().mockResolvedValue('{"ok":true,"result":{},"error":null}');

    t.registerRpcMethod('window_tool', handler);
    expect(registerRpcMethod).not.toHaveBeenCalled();

    await t.connect({ config: CONFIG, sessionStartUrl: START_URL });

    expect(registerRpcMethod).toHaveBeenCalledTimes(1);
    expect(registerRpcMethod.mock.calls[0]?.[0]).toBe('window_tool');
    // Bound BEFORE the join so an invocation arriving during it is handled.
    expect(registerRpcMethod.mock.invocationCallOrder[0]).toBeLessThan(
      roomConnect.mock.invocationCallOrder[0] as number,
    );
  });

  it('narrows the bound handler to the vendor-free invocation with agent resolution', async () => {
    const t = new LiveKitTransport();
    const seen: unknown[] = [];
    t.registerRpcMethod('window_tool', async (invocation) => {
      seen.push(invocation);
      return 'reply';
    });
    await t.connect({ config: CONFIG, sessionStartUrl: START_URL });
    remoteParticipants.set('agent:sess-1', { identity: 'agent:sess-1', kind: 'agent' });

    const bound = registerRpcMethod.mock.calls[0]?.[1] as (data: {
      payload: string;
      callerIdentity: string;
    }) => Promise<string>;
    const reply = await bound({ payload: '{"x":1}', callerIdentity: 'agent:sess-1' });

    expect(reply).toBe('reply');
    expect(seen).toEqual([
      { payload: '{"x":1}', callerIdentity: 'agent:sess-1', callerIsAgent: true },
    ]);
  });

  it('an unsubscribed pre-connect registration never binds', async () => {
    const t = new LiveKitTransport();
    const unsubscribe = t.registerRpcMethod('window_tool', vi.fn());
    unsubscribe();
    await t.connect({ config: CONFIG, sessionStartUrl: START_URL });
    expect(registerRpcMethod).not.toHaveBeenCalled();
  });

  it('rejects a duplicate pre-connect registration for the same method', () => {
    const t = new LiveKitTransport();
    t.registerRpcMethod('window_tool', vi.fn());
    expect(() => t.registerRpcMethod('window_tool', vi.fn())).toThrow(
      /already registered/,
    );
  });
});
