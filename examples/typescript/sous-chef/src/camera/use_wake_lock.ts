import { useEffect } from 'react';

/**
 * Hold a screen wake lock while a session is live — a phone that dims halfway
 * through a step stops showing the card and stops streaming the pan. The lock
 * dissolves whenever the page is backgrounded, so it is re-acquired on every
 * return to visibility.
 * Best-effort: browsers without the API just keep their normal timeout.
 */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let stopped = false;

    const acquire = async () => {
      try {
        const next = await navigator.wakeLock.request('screen');
        if (stopped) {
          void next.release().catch(() => undefined);
          return;
        }
        lock = next;
      } catch (err) {
        console.warn('[sous-chef] wake lock unavailable', err);
      }
    };

    const onVisible = () => {
      if (document.visibilityState === 'visible') void acquire();
    };

    void acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onVisible);
      void lock?.release().catch(() => undefined);
    };
  }, [active]);
}
