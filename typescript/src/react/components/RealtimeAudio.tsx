'use client';

import { log } from '../../core/logger';
import { useEffect, useRef } from 'react';

import { useRealtimeAudioElementRef, useRealtimeSessionContext } from '../RealtimeProvider';

export type RealtimeAudioProps = {
  /** Fired when the browser refuses to auto-play (HTMLMediaElement.play
   *  rejects). Hosts typically surface a "Click to enable audio" toast
   *  on this signal and call ``element.play()`` from a user gesture. */
  onError?: (err: unknown) => void;
};

/**
 * Hidden ``<audio>`` element that the realtime transport attaches the
 * remote bot audio track to.
 *
 * The element lives in the React tree (instead of the transport
 * appending a hidden node to ``document.body``) so it follows normal
 * mount/unmount lifecycles, is testable via DOM queries, and the
 * transport never reaches outside its boundary.
 */
export function RealtimeAudio({ onError }: RealtimeAudioProps) {
  const session = useRealtimeSessionContext();
  const providerAudioRef = useRealtimeAudioElementRef();
  const ref = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || session === null) return;
    session.attachAudioElement(el);
    return () => {
      session.attachAudioElement(null);
    };
  }, [session]);

  useEffect(() => {
    providerAudioRef.current = ref.current;
    return () => {
      providerAudioRef.current = null;
    };
  }, [providerAudioRef]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !onError) return;
    const handle = (event: Event) => onError(event);
    el.addEventListener('error', handle);
    return () => {
      el.removeEventListener('error', handle);
    };
  }, [onError]);

  // Propagate autoplay status back into ``media.output`` so
  // ``<StartAudio />`` and ``useMediaState()`` consumers can render an
  // "unblock audio" affordance. The ``autoPlay`` attribute below
  // requests playback, but browsers may refuse it silently (Safari,
  // mobile Chromium without user gesture); we attempt ``play()``
  // explicitly when a track is attached so the rejection surfaces, and
  // we watch the ``pause``/``playing`` events to track later
  // transitions when the user clicks "Tap to enable".
  useEffect(() => {
    const el = ref.current;
    if (!el || session === null) return;
    const tryPlay = (): void => {
      const result = el.play();
      if (result === undefined) return;
      result.catch((err) => {
        log.warn('[realtime] audio autoplay blocked', err);
        session.setOutputBlocked(true);
        onError?.(err);
      });
    };
    const onPlaying = (): void => session.setOutputBlocked(false);
    const onPause = (): void => {
      if (el.srcObject && el.paused) session.setOutputBlocked(true);
    };
    const onLoadedMetadata = (): void => tryPlay();
    el.addEventListener('loadedmetadata', onLoadedMetadata);
    el.addEventListener('playing', onPlaying);
    el.addEventListener('pause', onPause);
    // If a track is already attached when this effect runs (e.g.
    // RealtimeAudio mounted after the transport attached the remote
    // bot audio), try once now so the blocked state reflects reality.
    if (el.srcObject) tryPlay();
    return () => {
      el.removeEventListener('loadedmetadata', onLoadedMetadata);
      el.removeEventListener('playing', onPlaying);
      el.removeEventListener('pause', onPause);
    };
  }, [session, onError]);

  return <audio ref={ref} autoPlay style={{ display: 'none' }} />;
}
