// @vitest-environment jsdom
/**
 * LiveKitTransport.sendBytes: a large binary payload rides a LiveKit byte
 * stream targeted to the agent participant(s) only, never the reliable data
 * channel and never broadcast to the room. Mirrors the Python/Swift SDKs'
 * agent-targeted byte-stream primitive.
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
import type { SessionConfig } from '../../wire/types.gen';

type FakeParticipant = { identity: string; kind: string };

const {
  setMic,
  roomConnect,
  publishData,
  streamBytes,
  writerWrite,
  writerClose,
  remoteParticipants,
} = vi.hoisted(() => {
  const writerWrite = vi.fn().mockResolvedValue(undefined);
  const writerClose = vi.fn().mockResolvedValue(undefined);
  return {
    setMic: vi.fn().mockResolvedValue(undefined),
    roomConnect: vi.fn().mockResolvedValue(undefined),
    publishData: vi.fn().mockResolvedValue(undefined),
    streamBytes: vi.fn().mockResolvedValue({ write: writerWrite, close: writerClose }),
    writerWrite,
    writerClose,
    remoteParticipants: new Map<string, { identity: string; kind: string }>(),
  };
});

vi.mock('livekit-client', () => {
  class Room {
    state = 'connected';
    remoteParticipants = remoteParticipants;
    localParticipant = { setMicrophoneEnabled: setMic, publishData, streamBytes };
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

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function setParticipants(...participants: FakeParticipant[]): void {
  remoteParticipants.clear();
  for (const p of participants) remoteParticipants.set(p.identity, p);
}

let fetchMock: Mock;

beforeEach(() => {
  setMic.mockClear();
  roomConnect.mockClear();
  publishData.mockClear();
  streamBytes.mockClear();
  writerWrite.mockClear().mockResolvedValue(undefined);
  writerClose.mockClear().mockResolvedValue(undefined);
  remoteParticipants.clear();
  fetchMock = vi.fn().mockResolvedValue(okResponse(SESSION_RESPONSE));
  global.fetch = fetchMock as unknown as typeof fetch;
});

async function connectedTransport(): Promise<LiveKitTransport> {
  const t = new LiveKitTransport();
  await t.connect({ config: CONFIG, sessionStartUrl: START_URL });
  return t;
}

describe('LiveKitTransport.sendBytes', () => {
  it('opens a byte stream to the agent only and writes then closes it', async () => {
    const t = await connectedTransport();
    setParticipants(
      { identity: 'agent:sess-1', kind: 'agent' },
      { identity: 'user:human-1', kind: 'standard' },
    );
    const payload = new Uint8Array([1, 2, 3, 4]);

    await t.sendBytes(payload, 'screen-control');

    expect(streamBytes).toHaveBeenCalledTimes(1);
    expect(streamBytes).toHaveBeenCalledWith({
      topic: 'screen-control',
      destinationIdentities: ['agent:sess-1'],
    });
    expect(writerWrite).toHaveBeenCalledWith(payload);
    expect(writerClose).toHaveBeenCalledTimes(1);
    // Write must land before the stream is closed.
    expect(writerWrite.mock.invocationCallOrder[0]).toBeLessThan(
      writerClose.mock.invocationCallOrder[0],
    );
    // The binary payload never touches the reliable data channel.
    expect(publishData).not.toHaveBeenCalledWith(payload, expect.anything());
  });

  it('targets every agent when more than one is present', async () => {
    const t = await connectedTransport();
    setParticipants(
      { identity: 'agent:sess-1', kind: 'agent' },
      { identity: 'agent:whisper-1', kind: 'agent' },
      { identity: 'user:human-1', kind: 'standard' },
    );

    await t.sendBytes(new Uint8Array([9]), 'screen-control');

    expect(streamBytes).toHaveBeenCalledWith({
      topic: 'screen-control',
      destinationIdentities: ['agent:sess-1', 'agent:whisper-1'],
    });
  });

  it('rejects and opens no stream when no agent participant is present', async () => {
    const t = await connectedTransport();
    setParticipants({ identity: 'user:human-1', kind: 'standard' });

    await expect(t.sendBytes(new Uint8Array([1]), 'screen-control')).rejects.toThrow(
      /No agent participant/,
    );
    expect(streamBytes).not.toHaveBeenCalled();
  });

  it('rejects and opens no stream when the transport is not connected', async () => {
    const t = new LiveKitTransport();
    setParticipants({ identity: 'agent:sess-1', kind: 'agent' });

    await expect(t.sendBytes(new Uint8Array([1]), 'screen-control')).rejects.toThrow(
      /not connected/,
    );
    expect(streamBytes).not.toHaveBeenCalled();
  });

  it('closes the writer even when the write fails', async () => {
    const t = await connectedTransport();
    setParticipants({ identity: 'agent:sess-1', kind: 'agent' });
    writerWrite.mockRejectedValueOnce(new Error('stream write boom'));

    await expect(t.sendBytes(new Uint8Array([1]), 'screen-control')).rejects.toThrow(
      /stream write boom/,
    );
    expect(writerClose).toHaveBeenCalledTimes(1);
  });
});
