import { describe, expect, it, vi } from 'vitest';
import { TextEncoder as NodeTextEncoder, TextDecoder as NodeTextDecoder } from 'util';

if (typeof global.TextEncoder === 'undefined') {
  global.TextEncoder = NodeTextEncoder as typeof global.TextEncoder;
}
if (typeof global.TextDecoder === 'undefined') {
  global.TextDecoder = NodeTextDecoder as typeof global.TextDecoder;
}

import { RealtimeClient } from '../realtime_client';
import { makeFakeTransport } from './test_helpers';
import { naturalness } from '../../presets';

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

describe('agent voice.speakingStyle → agent.voice.speaking_style', () => {

  it('forwards a preset string as agent.voice.speaking_style', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ transportFactory: () => fake });

    await client.agent({ voice: { speakingStyle: naturalness('human') } }).start({});

    expect(fake.lastConfig()?.agent?.voice?.speaking_style).toBe(naturalness('human'));
  });

  it('forwards a literal string as agent.voice.speaking_style', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ transportFactory: () => fake });

    await client.agent({ voice: { speakingStyle: 'literal text' } }).start({});

    expect(fake.lastConfig()?.agent?.voice?.speaking_style).toBe('literal text');
  });

  it('omits the voice block when no voice is supplied', async () => {
    const fake = makeFakeTransport();
    const client = new RealtimeClient({ transportFactory: () => fake });

    await client.agent().start({});

    expect(fake.lastConfig()?.agent?.voice).toBeUndefined();
  });
});
