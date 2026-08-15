import { useCookState } from '../state/cook';

function mmss(totalSeconds: number): string {
  const whole = Math.max(0, Math.ceil(totalSeconds));
  return `${String(Math.floor(whole / 60))}:${String(whole % 60).padStart(2, '0')}`;
}

/** One chip per running timer. The countdown is local, so it keeps ticking
 *  even if the session drops. Only the chip that just fired is announced —
 *  a live region on the countdown itself would read the clock every second. */
export function TimerChips() {
  const { timers, alert } = useCookState();
  if (timers.length === 0 && alert === null) return null;

  return (
    <div className="timer-row">
      {alert !== null && (
        <span className="timer-chip timer-chip--fired" role="alert">
          {`${alert} is ready`}
        </span>
      )}
      {timers.map((timer) => (
        <span key={timer.label} className="timer-chip">
          <span className="timer-label">{timer.label}</span>
          <span className="timer-clock">{mmss(timer.remainingSeconds)}</span>
        </span>
      ))}
    </div>
  );
}
