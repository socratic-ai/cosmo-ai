'use client';

import { useCallback } from 'react';

import { useMediaState, useTransportState } from '../hooks';
import { useRealtimeClient } from '../RealtimeProvider';

export type MicToggleProps = {
  /** Optional className forwarded to the root ``<button>``. */
  className?: string;
  /** Override the rendered text. When omitted the button shows
   *  "Mute" / "Unmute" so the component stays usable with zero styling. */
  label?: { muted: string; unmuted: string };
  /** Called when ``setMicMuted`` rejects (transport failure, session
   *  not ready). The SDK has already rolled back its optimistic
   *  state by the time this fires — use it to surface a toast or
   *  inline error. */
  onError?: (err: unknown) => void;
};

/**
 * Mic mute/unmute button bound to the SDK's media state.
 *
 * Intentionally renders a plain ``<button>`` with no opinions about
 * styling or icon library — host apps style it via ``className`` or
 * build their own component on top of ``useRealtimeClient()`` and
 * ``useMediaState()``. The component is self-contained: importing it
 * pulls in no icon library or design-system dependency.
 */
export function MicToggle({ className, label, onError }: MicToggleProps) {
  const client = useRealtimeClient();
  const media = useMediaState();
  const transportState = useTransportState();
  const muted = media.mic === 'muted';
  const text = muted
    ? (label?.muted ?? 'Unmute')
    : (label?.unmuted ?? 'Mute');
  const ariaLabel = muted ? 'Unmute microphone' : 'Mute microphone';
  const disabled = transportState !== 'ready';

  const handleClick = useCallback(() => {
    // ``setMicMuted`` rejects when the transport publish fails (mic
    // toggle out of sync, network drop mid-toggle, etc.). Catch so
    // the unawaited promise doesn't surface as an unhandled rejection,
    // and route to the host via ``onError`` for UX feedback.
    client.setMicMuted(!muted).catch((err: unknown) => {
      onError?.(err);
    });
  }, [client, muted, onError]);

  return (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-pressed={muted}
      onClick={handleClick}
      disabled={disabled}
      className={className}
    >
      {text}
    </button>
  );
}
