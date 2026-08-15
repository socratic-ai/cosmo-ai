// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveKitTransport } from '../livekit_transport';
import type { SessionConfig } from '../../wire/types.gen';

const mockHandlers = vi.hoisted(
  (): Record<string, (...args: unknown[]) => void> => ({}),
);

vi.mock('livekit-client', () => {
  class Room {
    localParticipant = { setMicrophoneEnabled: vi.fn() };
    startAudio = vi.fn().mockResolvedValue(undefined);
    on(event: string, cb: (...args: unknown[]) => void) {
      mockHandlers[event] = cb;
      return this;
    }
    connect = vi.fn().mockResolvedValue(undefined);
    async disconnect() {}
  }
  return {
    Room,
    RoomEvent: {
      TrackSubscribed: 'trackSubscribed',
      TrackUnsubscribed: 'trackUnsubscribed',
      DataReceived: 'dataReceived',
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

function audioTrack() {
  return { kind: 'audio', attach: vi.fn(), detach: vi.fn() };
}

function fire(event: string, ...args: unknown[]): void {
  mockHandlers[event]?.(...args);
}

const CONFIG: SessionConfig = { type: 'session-config' };

const SESSION_RESPONSE = {
  livekit_url: 'wss://lk.example',
  token: 'lk-jwt',
  room_name: 'room-1',
  session_id: 'sess-1',
};

async function connectedTransport(): Promise<LiveKitTransport> {
  const t = new LiveKitTransport();
  await t.connect({
    config: CONFIG,
    sessionStartUrl: 'https://api.example.com/api/v1/external/realtime/session/start',
    publishMicrophone: false,
  });
  return t;
}

describe('LiveKitTransport remote audio (one element per track)', () => {
  beforeEach(() => {
    for (const k of Object.keys(mockHandlers)) delete mockHandlers[k];
    global.fetch = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => SESSION_RESPONSE,
      } as unknown as Response) as unknown as typeof fetch;
  });

  it('plays simultaneous remote tracks on separate elements', async () => {
    await connectedTransport();

    const agentTrack = audioTrack();
    const sipTrack = audioTrack();
    fire('trackSubscribed', agentTrack);
    fire('trackSubscribed', sipTrack);

    // The first track lands on the host element; the second on its own
    // element. Both are attached, so the listener hears both remote
    // speakers at once (last-attached-wins would have dropped one).
    expect(agentTrack.attach).toHaveBeenCalledTimes(1);
    expect(sipTrack.attach).toHaveBeenCalledTimes(1);
    expect(agentTrack.attach.mock.calls[0][0]).not.toBe(
      sipTrack.attach.mock.calls[0][0],
    );
  });

  it('tears down the extra element when a simultaneous track leaves', async () => {
    await connectedTransport();

    const agentTrack = audioTrack();
    const sipTrack = audioTrack();
    fire('trackSubscribed', agentTrack);
    fire('trackSubscribed', sipTrack);

    fire('trackUnsubscribed', sipTrack);

    // The extra speaker left: its dedicated element is detached and the
    // first track keeps playing uninterrupted on the host element.
    expect(sipTrack.detach).toHaveBeenCalledTimes(1);
    expect(agentTrack.detach).not.toHaveBeenCalled();
  });

  it('promotes a remaining track onto the host element when the primary leaves', async () => {
    await connectedTransport();

    const agentTrack = audioTrack();
    const sipTrack = audioTrack();
    fire('trackSubscribed', agentTrack);
    fire('trackSubscribed', sipTrack);
    sipTrack.attach.mockClear();

    fire('trackUnsubscribed', agentTrack);

    // The host-element track left, so the remaining track is re-attached
    // to the host element to keep the analyser/AEC tap live.
    expect(agentTrack.detach).toHaveBeenCalled();
    expect(sipTrack.attach).toHaveBeenCalledTimes(1);
  });
});
