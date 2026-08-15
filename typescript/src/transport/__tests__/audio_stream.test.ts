// @vitest-environment jsdom
/**
 * LiveKitTransport.startAudioStream: taking the session's voice with a
 * caller-owned ``MediaStream``, the ``bind-input`` / ``mute`` frames without
 * which the agent never listens to it, and the microphone swap that keeps
 * exactly one track claiming the voice.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TextEncoder as NodeTextEncoder, TextDecoder as NodeTextDecoder } from 'util';

if (typeof global.TextEncoder === 'undefined') {
  global.TextEncoder = NodeTextEncoder as typeof global.TextEncoder;
}
if (typeof global.TextDecoder === 'undefined') {
  global.TextDecoder = NodeTextDecoder as typeof global.TextDecoder;
}

import { AudioPublishAlreadyActiveError } from '../../core/errors';
import { LiveKitTransport } from '../livekit_transport';
import type { SessionConfig } from '../../wire/types.gen';

const { publishTrack, unpublishTrack, publishData, getTrackPublication, mockHandlers } = vi.hoisted(
  () => ({
    publishTrack: vi.fn(),
    unpublishTrack: vi.fn().mockResolvedValue(undefined),
    publishData: vi.fn().mockResolvedValue(undefined),
    getTrackPublication: vi.fn(),
    mockHandlers: {} as Record<string, (...args: unknown[]) => void>,
  }),
);

/** The still-open microphone track a session with a live mic is publishing. */
const MIC_TRACK = { id: 'mic-track' };

vi.mock('livekit-client', () => {
  class Room {
    state = 'connected';
    localParticipant = {
      setMicrophoneEnabled: vi.fn().mockResolvedValue(undefined),
      publishTrack,
      unpublishTrack,
      publishData,
      getTrackPublication,
    };
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
    LocalAudioTrack: class {
      constructor(readonly mediaStreamTrack: unknown) {}
    },
    LocalVideoTrack: class {},
    RemoteTrack: class {},
  };
});

/** A ``MediaStream`` stand-in carrying ``audioTracks`` audio tracks. */
function mediaStream(audioTracks: number): MediaStream {
  const tracks = Array.from({ length: audioTracks }, (_, i) => ({ id: `a${i}` }));
  return { getAudioTracks: () => tracks } as unknown as MediaStream;
}

const START_URL = 'https://api.example.com/api/v1/external/realtime/session/start';

const CONFIG: SessionConfig = {
  type: 'session-config',
};

const SESSION_RESPONSE = {
  livekit_url: 'wss://lk.example',
  token: 'lk-jwt',
  room_name: 'room-1',
  session_id: 'sess-1',
};

function publishedFrames(): Array<{ type: string; muted?: boolean }> {
  return publishData.mock.calls.map(
    ([bytes]) =>
      JSON.parse(new TextDecoder().decode(bytes as Uint8Array)) as {
        type: string;
        muted?: boolean;
      },
  );
}

/** Connect without publishing the browser mic, so each suite's frames start
 *  from a clean slate. */
async function connectedTransport(): Promise<LiveKitTransport> {
  const t = new LiveKitTransport();
  await t.connect({
    config: CONFIG,
    sessionStartUrl: START_URL,
    publishMicrophone: false,
  });
  publishData.mockClear();
  return t;
}

beforeEach(() => {
  publishTrack.mockReset().mockResolvedValue({ trackSid: 'TR_audio1', track: { id: 't1' } });
  unpublishTrack.mockClear();
  publishData.mockClear();
  // No microphone publishing unless a test says otherwise.
  getTrackPublication.mockReset().mockReturnValue(undefined);
  for (const key of Object.keys(mockHandlers)) delete mockHandlers[key];
  global.fetch = vi
    .fn()
    .mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => SESSION_RESPONSE,
    } as unknown as Response) as unknown as typeof fetch;
});

/** Put a live microphone in the room for the displacement tests. */
function withLiveMicrophone(): void {
  getTrackPublication.mockReturnValue({ track: MIC_TRACK });
}

describe('LiveKitTransport.startAudioStream', () => {
  it('publishes the stream as a microphone-source track', async () => {
    const t = await connectedTransport();

    await t.startAudioStream(mediaStream(1));

    expect(publishTrack).toHaveBeenCalledTimes(1);
    const [, options] = publishTrack.mock.calls[0] as [unknown, Record<string, unknown>];
    // Microphone source is what marks the track as the session's voice; the
    // agent would otherwise treat it as incidental audio.
    expect(options.source).toBe('microphone');
  });

  it('declares the session voice and clears the server mute gate', async () => {
    const t = await connectedTransport();

    await t.startAudioStream(mediaStream(1));

    // Without both frames the track publishes but the agent never hears it —
    // a silent failure with no error anywhere.
    expect(publishedFrames()).toEqual([{ type: 'bind-input' }, { type: 'mute', muted: false }]);
  });

  it('rejects a stream with no audio track instead of publishing nothing', async () => {
    const t = await connectedTransport();

    await expect(t.startAudioStream(mediaStream(0))).rejects.toThrow(
      'Audio stream must contain at least one audio track.',
    );
    expect(publishTrack).not.toHaveBeenCalled();
  });

  it('rejects when there is no active session', async () => {
    const t = new LiveKitTransport();

    await expect(t.startAudioStream(mediaStream(1))).rejects.toThrow(
      'Cannot add audio stream — no active session.',
    );
  });

  it('refuses a second stream while one is running', async () => {
    // A session carries one voice. Two tracks both claiming the microphone
    // source leave the agent — and setMicMuted, and getInputStream — picking
    // between them arbitrarily.
    const t = await connectedTransport();
    await t.startAudioStream(mediaStream(1));

    await expect(t.startAudioStream(mediaStream(1))).rejects.toThrow(
      AudioPublishAlreadyActiveError,
    );
    expect(publishTrack).toHaveBeenCalledTimes(1);
  });

  it('accepts a new stream once the running one is stopped', async () => {
    const t = await connectedTransport();
    await t.startAudioStream(mediaStream(1));
    await t.stopAudioStream();

    await expect(t.startAudioStream(mediaStream(1))).resolves.toBeUndefined();
  });

  it('displaces a live microphone without stopping it', async () => {
    // Stopping the mic here would force a reopen on restore, which is the
    // open→stop→reopen cycle that yields a silent track on macOS.
    withLiveMicrophone();
    const t = await connectedTransport();

    await t.startAudioStream(mediaStream(1));

    expect(unpublishTrack).toHaveBeenCalledTimes(1);
    expect(unpublishTrack.mock.calls[0]).toEqual([MIC_TRACK, false]);
  });

  it('puts the microphone back when the publish is rejected', async () => {
    // The grant may not have propagated yet — the rejection window the mic
    // re-enable retry covers. Without the restore the microphone is
    // unpublished, untracked, and unreachable: stopAudioStream has no
    // stream to stop.
    withLiveMicrophone();
    const t = await connectedTransport();
    publishTrack.mockRejectedValueOnce(new Error('publish grant not propagated'));

    await expect(t.startAudioStream(mediaStream(1))).rejects.toThrow(
      'publish grant not propagated',
    );

    const republished = publishTrack.mock.calls.filter(([track]) => track === MIC_TRACK);
    expect(republished).toHaveLength(1);
    expect((republished[0][1] as Record<string, unknown>).source).toBe('microphone');
  });

  it('records no stream when the publish is rejected', async () => {
    withLiveMicrophone();
    const t = await connectedTransport();
    publishTrack.mockRejectedValueOnce(new Error('publish grant not propagated'));
    await expect(t.startAudioStream(mediaStream(1))).rejects.toThrow();

    // The slot must be free — a failed start that held it would refuse every
    // later attempt with AudioPublishAlreadyActiveError.
    publishTrack.mockResolvedValue({ trackSid: 'TR_retry', track: { id: 't2' } });
    await expect(t.startAudioStream(mediaStream(1))).resolves.toBeUndefined();
  });

  it('leaves the microphone alone when none is publishing', async () => {
    const t = await connectedTransport();

    await t.startAudioStream(mediaStream(1));

    expect(unpublishTrack).not.toHaveBeenCalled();
  });
});

describe('LiveKitTransport.stopAudioStream', () => {
  it('unpublishes the track and stops it', async () => {
    const t = await connectedTransport();
    await t.startAudioStream(mediaStream(1));

    await t.stopAudioStream();

    expect(unpublishTrack).toHaveBeenCalledTimes(1);
    expect(unpublishTrack.mock.calls[0]).toEqual([{ id: 't1' }, true]);
  });

  it('is idempotent', async () => {
    const t = await connectedTransport();
    await t.startAudioStream(mediaStream(1));

    await t.stopAudioStream();
    await t.stopAudioStream();

    expect(unpublishTrack).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when no stream is running', async () => {
    const t = await connectedTransport();

    await t.stopAudioStream();

    expect(unpublishTrack).not.toHaveBeenCalled();
  });

  it('hands the voice back to the microphone it displaced', async () => {
    withLiveMicrophone();
    const t = await connectedTransport();
    await t.startAudioStream(mediaStream(1));
    publishTrack.mockClear();

    await t.stopAudioStream();

    // The same track object, republished — never a fresh capture.
    expect(publishTrack).toHaveBeenCalledTimes(1);
    const [track, options] = publishTrack.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(track).toBe(MIC_TRACK);
    expect(options.source).toBe('microphone');
  });

  it('republishes no microphone when the session had none', async () => {
    const t = await connectedTransport();
    await t.startAudioStream(mediaStream(1));
    publishTrack.mockClear();

    await t.stopAudioStream();

    expect(publishTrack).not.toHaveBeenCalled();
  });
});
