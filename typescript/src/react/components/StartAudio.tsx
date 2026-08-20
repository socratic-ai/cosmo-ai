'use client';

import { log } from '../../core/logger';
import { useCallback, type ReactNode } from 'react';

import { useMediaState } from '../hooks';
import { useRealtimeAudioElementRef, useRealtimeSessionContext } from '../RealtimeProvider';

export type StartAudioRenderArgs = {
  /** ``true`` when the browser is currently blocking remote audio
   *  autoplay (or any other downstream gate the SDK signals via
   *  ``mediaState.output === 'blocked'``). */
  blocked: boolean;
  /** Best-effort attempt to unblock audio. Called from a user gesture
   *  handler. Plays the host ``<audio>`` element that
   *  ``<RealtimeAudio />`` mirrored into the provider. */
  start: () => Promise<void>;
};

export type StartAudioProps = {
  /** Custom affordance. Omit it to get the default button. */
  children?: (args: StartAudioRenderArgs) => ReactNode;
  /** Label on the default button. Ignored when ``children`` is supplied. */
  label?: string;
  className?: string;
};

/**
 * Autoplay unlock.
 *
 * Browsers (Safari, mobile Chromium) block remote audio playback until
 * a user gesture. Drop it in next to ``<RealtimeAudio />`` for a default
 * "Tap to enable voice" button that renders only while playback is
 * blocked; pass a render prop for a ``blocked`` boolean and a ``start``
 * callback to wire your own affordance.
 */
export function StartAudio({ children, label, className }: StartAudioProps) {
  const media = useMediaState();
  const audioRef = useRealtimeAudioElementRef();
  const session = useRealtimeSessionContext();
  const blocked = media.output === 'blocked';

  const start = useCallback(async () => {
    // Replay the host element (mirrored by <RealtimeAudio/>) AND every
    // per-track element the transport owns (extra simultaneous remote
    // speakers). resumeAudioPlayback also calls Room.startAudio.
    const el = audioRef.current;
    if (el) {
      try {
        await el.play();
      } catch (err) {
        log.warn('[realtime] StartAudio play() failed', err);
      }
    }
    try {
      await session?.resumeAudioPlayback();
    } catch (err) {
      log.warn('[realtime] StartAudio resumeAudioPlayback failed', err);
    }
  }, [audioRef, session]);

  if (children) return <>{children({ blocked, start })}</>;
  if (!blocked) return null;
  return (
    <button type="button" className={className} onClick={() => void start()}>
      {label ?? 'Tap to enable voice'}
    </button>
  );
}
