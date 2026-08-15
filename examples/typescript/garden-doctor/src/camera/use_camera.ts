import { useCallback, useRef, useState } from 'react';

import type { RealtimeSession } from 'cosmo-ai';
import type { VideoStreamHandle } from 'cosmo-ai/transport/types';

export type CameraFacing = 'environment' | 'user';

export type Camera = {
  /** The local capture stream, for the preview. Null when off. */
  stream: MediaStream | null;
  /** Which lens is live. Front (`user`) previews mirrored, rear does not. */
  facingMode: CameraFacing;
  /** True when the device exposes more than one camera, so ``flip`` is useful. */
  canFlip: boolean;
  /** Acquire the rear lens and start a local preview. Rejects on denial. */
  start: () => Promise<void>;
  /** Publish the live capture to the session as a camera-kind video track. */
  publish: (session: RealtimeSession) => Promise<void>;
  /** Switch between front and rear lens while live, republishing. */
  flip: () => Promise<void>;
  /** Unpublish (when published) and release the hardware. Safe when off. */
  stop: () => Promise<void>;
};

function openCamera(facing: CameraFacing): Promise<MediaStream> {
  // ``ideal`` (not ``exact``) so a single-camera laptop falls back to its
  // only webcam instead of throwing an OverconstrainedError.
  return navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing } } });
}

/**
 * Owns the local camera lifecycle: acquire via ``getUserMedia``, publish as a
 * camera-kind track, flip, and tear down. Defaults to the rear lens so a
 * phone pointed at a plant streams the plant, not the gardener.
 *
 * The live stream/handle/facing are held in refs, not just React state, so
 * the async operations always read the current values (never what an
 * ``await`` left stale) — and a ``busy`` guard serialises them, because the
 * camera is single-owner and overlapping acquire/release calls would
 * double-open or orphan a track.
 */
export function useCamera(): Camera {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [facingMode, setFacingMode] = useState<CameraFacing>('environment');
  const [canFlip, setCanFlip] = useState(false);

  const streamRef = useRef<MediaStream | null>(null);
  const handleRef = useRef<VideoStreamHandle | null>(null);
  const sessionRef = useRef<RealtimeSession | null>(null);
  const facingRef = useRef<CameraFacing>('environment');
  const busyRef = useRef(false);

  const release = useCallback(async (): Promise<void> => {
    const handle = handleRef.current;
    const session = sessionRef.current;
    if (handle !== null && session !== null) {
      try {
        await session.removeVideoStream(handle);
      } catch (err) {
        console.error('[garden-doctor] removeVideoStream failed', err);
      }
    }
    handleRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setStream(null);
  }, []);

  const acquire = useCallback(async (facing: CameraFacing): Promise<MediaStream> => {
    const next = await openCamera(facing);
    streamRef.current = next;
    facingRef.current = facing;
    setStream(next);
    setFacingMode(facing);
    return next;
  }, []);

  const start = useCallback(async (): Promise<void> => {
    if (busyRef.current || streamRef.current !== null) return;
    busyRef.current = true;
    try {
      await acquire('environment');
      const devices = await navigator.mediaDevices.enumerateDevices();
      setCanFlip(devices.filter((d) => d.kind === 'videoinput').length > 1);
    } finally {
      busyRef.current = false;
    }
  }, [acquire]);

  // If publishing fails after acquisition, release the stream so the camera
  // hardware is never left locked with no handle to recover it.
  const publish = useCallback(
    async (session: RealtimeSession): Promise<void> => {
      const live = streamRef.current;
      if (live === null) throw new Error('camera is not on');
      sessionRef.current = session;
      try {
        handleRef.current = await session.addVideoStream(live, { kind: 'camera' });
      } catch (err) {
        await release();
        throw err;
      }
    },
    [release],
  );

  const flip = useCallback(async (): Promise<void> => {
    if (busyRef.current || streamRef.current === null) return;
    busyRef.current = true;
    try {
      const wasPublished = handleRef.current !== null;
      const session = sessionRef.current;
      const nextFacing: CameraFacing = facingRef.current === 'environment' ? 'user' : 'environment';
      // Release the current lens before opening the other — phone cameras are
      // single-owner, so acquiring the second while the first is live can fail.
      await release();
      const next = await acquire(nextFacing);
      if (wasPublished && session !== null) {
        handleRef.current = await session.addVideoStream(next, { kind: 'camera' });
      }
    } finally {
      busyRef.current = false;
    }
  }, [acquire, release]);

  const stop = useCallback(async (): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      await release();
      sessionRef.current = null;
    } finally {
      busyRef.current = false;
    }
  }, [release]);

  return { stream, facingMode, canFlip, start, publish, flip, stop };
}
