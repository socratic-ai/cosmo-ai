import { useEffect } from 'react';
import { useAgentState, useOutputLevel, useToolCalls } from 'cosmo-ai';

import { cookStore, useCookState } from '../state/cook';

export type ChefMood = 'idle' | 'listening' | 'thinking' | 'speaking' | 'looking' | 'alert';

/** The server-side tool that reads the freshest camera frame. Seeing it
 *  in flight is what "looking" means. */
const EXAMINE_TOOL = 'cosmo_examine_image';

/** The chef's face is session state made visible: the agent's own lifecycle
 *  from the SDK, "looking" while it is reading a frame, and "alert" when a
 *  timer has just landed. Nothing here is animation for its own sake — each
 *  expression names something the session is actually doing. */
export function useChefMood(): ChefMood {
  const agentState = useAgentState();
  const toolCalls = useToolCalls();
  const { alert } = useCookState();

  if (alert !== null) return 'alert';
  const looking = toolCalls.some(
    (call) => call.status === 'in_flight' && call.name === EXAMINE_TOOL,
  );
  return looking ? 'looking' : agentState;
}

/** The face on its own, with no session behind it, so the start screen can
 *  show the same chef the live screen does. */
export function ChefFace({ mouthScale = 0.35 }: { mouthScale?: number }) {
  return (
    <svg viewBox="0 0 120 116" role="presentation">
      <g className="avatar-hat">
        <circle cx="42" cy="24" r="13" fill="#fff" stroke="#e4ded2" />
        <circle cx="60" cy="18" r="15" fill="#fff" stroke="#e4ded2" />
        <circle cx="78" cy="24" r="13" fill="#fff" stroke="#e4ded2" />
        <rect x="40" y="30" width="40" height="14" rx="4" fill="#fff" stroke="#e4ded2" />
      </g>
      <circle cx="60" cy="72" r="29" fill="#f2c9a0" />
      <g className="avatar-eyes">
        <circle cx="50" cy="68" r="3.4" fill="#2b2620" />
        <circle cx="70" cy="68" r="3.4" fill="#2b2620" />
      </g>
      <ellipse
        className="avatar-mouth"
        cx="60"
        cy="84"
        rx="8"
        ry="5"
        fill="#7a3b2e"
        style={{ transform: `scaleY(${String(mouthScale)})`, transformOrigin: '60px 84px' }}
      />
    </svg>
  );
}

/** What the chef is thinking, when that is worth a word: a bubble for the two
 *  states you cannot hear — working something out, and reading the frame — and
 *  for the timer that just landed. It repeats what the timer chip already
 *  says, so it is decoration to a screen reader. */
function bubbleFor(mood: ChefMood, alert: string | null): React.ReactNode {
  if (mood === 'alert' && alert !== null) return `${alert} is ready`;
  if (mood === 'looking') return 'looking…';
  if (mood === 'thinking') {
    return (
      <span className="bubble-dots">
        <i />
        <i />
        <i />
      </span>
    );
  }
  return null;
}

export function Avatar() {
  const mood = useChefMood();
  const level = useOutputLevel();
  const { alert } = useCookState();

  // Wet hands cannot dismiss anything, so the alert clears itself.
  useEffect(() => {
    if (alert === null) return;
    const timeout = setTimeout(() => {
      cookStore.clearAlert();
    }, 6000);
    return () => {
      clearTimeout(timeout);
    };
  }, [alert]);

  const bubble = bubbleFor(mood, alert);

  return (
    <button
      type="button"
      className={`avatar avatar--${mood}`}
      onClick={() => {
        cookStore.clearAlert();
      }}
      aria-label={`Sous-chef is ${mood}`}
    >
      {bubble !== null && (
        <span className={`bubble${mood === 'alert' ? ' bubble--alert' : ''}`} aria-hidden="true">
          {bubble}
        </span>
      )}
      <ChefFace mouthScale={mood === 'speaking' ? 0.4 + Math.min(level, 1) * 1.1 : 0.35} />
    </button>
  );
}
