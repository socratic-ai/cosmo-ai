// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import type { RealtimeClient } from '../../core/realtime_client';
import {
  makeFakeTransport,
  type FakeTransport,
} from '../../core/__tests__/test_helpers';
import { useRealtimeSession, type RealtimeSessionStartResult } from '../use_realtime_session';

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

function renderSession(fakes: FakeTransport[]) {
  let run = 0;
  return renderHook(() =>
    useRealtimeSession({
      makeAgent: (client: RealtimeClient) => client.agent({ instructions: 'be terse' }),
      clientOptions: { transportFactory: () => fakes[run++] },
    }),
  );
}

/** A fake transport whose ``connect`` blocks until ``release()`` — for
 *  driving what happens while a start is still in flight. */
function gatedTransport() {
  const fake = makeFakeTransport();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const originalConnect = fake.connect.bind(fake);
  fake.connect = async (opts) => {
    await gate;
    await originalConnect(opts);
  };
  return { fake, release };
}

describe('useRealtimeSession', () => {
  it('runs idle → starting → live and exposes the run', async () => {
    const fake = makeFakeTransport();
    const { result } = renderSession([fake]);

    expect(result.current.phase).toBe('idle');
    expect(result.current.client).toBeNull();

    let returned!: RealtimeSessionStartResult;
    await act(async () => {
      returned = await result.current.start();
    });

    expect(result.current.phase).toBe('live');
    expect(returned.ok).toBe(true);
    if (!returned.ok) throw new Error('unreachable');
    expect(result.current.session).toBe(returned.session);
    expect(result.current.client).not.toBeNull();
    expect(result.current.session?.sessionId).toBe('sess-fake');
    expect(result.current.error).toBeNull();
  });

  it('lands the start error and returns to idle when the connect fails', async () => {
    const fake = makeFakeTransport({ connectError: new Error('boom') });
    const { result } = renderSession([fake]);

    let returned!: RealtimeSessionStartResult;
    await act(async () => {
      returned = await result.current.start();
    });

    expect(returned.ok).toBe(false);
    if (returned.ok) throw new Error('unreachable');
    expect(returned.reason).toBe('failed');
    expect(returned.error?.message).toBe('boom');
    expect(result.current.phase).toBe('idle');
    expect(result.current.client).toBeNull();
    expect(result.current.session).toBeNull();
    expect(result.current.error?.message).toBe('boom');
  });

  it('reports busy for a second start while a run is underway', async () => {
    const fake = makeFakeTransport();
    const { result } = renderSession([fake]);

    await act(async () => {
      const [first, second] = await Promise.all([
        result.current.start(),
        result.current.start(),
      ]);
      expect(first.ok).toBe(true);
      expect(second).toEqual({ ok: false, reason: 'busy', error: null });
    });
    expect(result.current.phase).toBe('live');
  });

  it('surfaces server-rejected tools as typed specs plus the warning', async () => {
    const fake = makeFakeTransport();
    const { result } = renderSession([fake]);

    await act(async () => {
      await result.current.start();
    });
    act(() => {
      fake.emitMessage({
        type: 'ready',
        session_id: 'sess-fake',
        rejected_tools: [
          { name: 'examine_image', reason: 'not configured' },
          { name: 'detect_objects', reason: 'not configured' },
        ],
      });
    });

    expect(result.current.rejectedTools).toEqual([
      { name: 'examine_image', reason: 'not configured' },
      { name: 'detect_objects', reason: 'not configured' },
    ]);
    expect(result.current.warning).toBe(
      'The server rejected tools: examine_image, detect_objects',
    );
    expect(result.current.phase).toBe('live');
  });

  it('tears down on a server hangup: typed end record, client released, idle again', async () => {
    const fake = makeFakeTransport();
    const { result } = renderSession([fake]);

    await act(async () => {
      await result.current.start();
    });
    await act(async () => {
      fake.emitMessage({ type: 'session-ended', reason: 'max_session_duration' });
      fake.emitClose();
    });

    await waitFor(() => expect(result.current.phase).toBe('idle'));
    expect(result.current.client).toBeNull();
    expect(result.current.session).toBeNull();
    expect(result.current.lastEnd).toEqual({
      reason: 'server_ended',
      detail: 'max_session_duration',
    });
    expect(result.current.endedReason).toBe('max_session_duration');
    // The spent client's mic release ran: the transport got a disconnect.
    expect(fake.lastDisconnectOpts()).not.toBeUndefined();
  });

  it('treats end() as a clean exit: ending synchronously, no endedReason, ready again', async () => {
    const first = makeFakeTransport();
    const second = makeFakeTransport();
    const { result } = renderSession([first, second]);

    await act(async () => {
      await result.current.start();
    });

    let ended!: Promise<void>;
    act(() => {
      ended = result.current.end();
    });
    // 'ending' is entered before the graceful end lands, not after.
    expect(result.current.phase).toBe('ending');
    await act(async () => {
      await ended;
    });

    await waitFor(() => expect(result.current.phase).toBe('idle'));
    expect(result.current.lastEnd).toEqual({ reason: 'client_ended', detail: null });
    expect(result.current.endedReason).toBeNull();
    expect(first.lastDisconnectOpts()).toEqual({ sendEndFrame: true });

    await act(async () => {
      await result.current.start();
    });
    expect(result.current.phase).toBe('live');
    expect(result.current.session?.sessionId).toBe('sess-fake');
  });

  it('cancels a start still in flight when end() is called', async () => {
    const { fake, release } = gatedTransport();
    const { result } = renderSession([fake]);

    let pending!: Promise<RealtimeSessionStartResult>;
    act(() => {
      pending = result.current.start();
    });
    expect(result.current.phase).toBe('starting');

    await act(async () => {
      await result.current.end();
    });
    expect(result.current.phase).toBe('ending');

    release();
    let returned!: RealtimeSessionStartResult;
    await act(async () => {
      returned = await pending;
    });

    expect(returned).toEqual({ ok: false, reason: 'ended', error: null });
    await waitFor(() => expect(result.current.phase).toBe('idle'));
    expect(result.current.client).toBeNull();
    // The never-owned client still released its microphone.
    await waitFor(() => expect(fake.lastDisconnectOpts()).not.toBeUndefined());
  });

  it('disconnects a start that resolves after the owner unmounted', async () => {
    const { fake, release } = gatedTransport();
    const { result, unmount } = renderSession([fake]);

    let pending!: Promise<RealtimeSessionStartResult>;
    act(() => {
      pending = result.current.start();
    });
    expect(result.current.phase).toBe('starting');

    unmount();
    release();
    const returned = await pending;

    expect(returned).toEqual({ ok: false, reason: 'ended', error: null });
    await waitFor(() => expect(fake.lastDisconnectOpts()).not.toBeUndefined());
  });

  it('clears the previous run leftovers on the next start', async () => {
    const first = makeFakeTransport();
    const second = makeFakeTransport();
    const { result } = renderSession([first, second]);

    await act(async () => {
      await result.current.start();
    });
    act(() => {
      first.emitMessage({
        type: 'ready',
        session_id: 'sess-fake',
        rejected_tools: [{ name: 'examine_image', reason: 'not configured' }],
      });
    });
    await act(async () => {
      first.emitMessage({ type: 'session-ended', reason: 'max_session_duration' });
      first.emitClose();
    });
    await waitFor(() => expect(result.current.phase).toBe('idle'));
    expect(result.current.endedReason).toBe('max_session_duration');

    await act(async () => {
      await result.current.start();
    });
    expect(result.current.phase).toBe('live');
    expect(result.current.warning).toBeNull();
    expect(result.current.rejectedTools).toEqual([]);
    expect(result.current.lastEnd).toBeNull();
    expect(result.current.endedReason).toBeNull();
  });

  it('disconnects the live client when the owner unmounts', async () => {
    const fake = makeFakeTransport();
    const { result, unmount } = renderSession([fake]);

    await act(async () => {
      await result.current.start();
    });
    expect(fake.lastDisconnectOpts()).toBeUndefined();

    unmount();

    await waitFor(() => expect(fake.lastDisconnectOpts()).toEqual({ sendEndFrame: true }));
  });
});
