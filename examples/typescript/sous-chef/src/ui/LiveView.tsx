import { useState } from 'react';
import { MicToggle, RealtimeAudio, StartAudio, useTransportState } from 'cosmo-ai';

import { useWakeLock } from '../camera/use_wake_lock';
import { Avatar, useChefMood } from './Avatar';
import { CameraStage } from './CameraStage';
import { IngredientStrip } from './IngredientStrip';
import { RecipeHeader } from './RecipeHeader';
import { StatusPill } from './StatusPill';
import { StepCard } from './StepCard';
import { TimerChips } from './TimerChips';

type Props = {
  stream: MediaStream | null;
  note: string | null;
  onEnd: () => void;
};

/**
 * What the pan looks like, with only what you need over it.
 *
 * Everything that is not the frame lives in two bands — a line of reference
 * along the top, one dock across the bottom — and the middle is left alone,
 * because the middle is the food. There is no caption strip: the chef says all
 * of it out loud, and printing the same words under the step it just described
 * is the fastest way to lose the pan behind text.
 */
export function LiveView({ stream, note, onEnd }: Props) {
  const transport = useTransportState();
  const mood = useChefMood();
  const [micError, setMicError] = useState<string | null>(null);
  useWakeLock(true);

  return (
    <main className="app live">
      <CameraStage stream={stream} looking={mood === 'looking'} />
      <div className="hud">
        <header className="hud-top">
          <div className="hud-top-row">
            <StatusPill transport={transport} note={micError ?? note} />
            <TimerChips />
          </div>
          <RecipeHeader />
        </header>
        <div className="hud-bottom">
          <div className="panel dock">
            <StepCard />
            <IngredientStrip />
          </div>
          <div className="controls">
            <Avatar />
            <MicToggle
              className="btn"
              label={{ muted: 'Unmute', unmuted: 'Mute' }}
              onError={(err) => {
                console.error('[sous-chef] mic toggle failed', err);
                setMicError('The mic did not switch — try again.');
              }}
            />
            <button type="button" className="btn end" onClick={onEnd}>
              Done cooking
            </button>
          </div>
        </div>
      </div>
      <RealtimeAudio />
      <StartAudio>
        {({ blocked, start }) =>
          blocked ? (
            <button type="button" className="btn unlock" onClick={() => void start()}>
              Tap to hear the chef
            </button>
          ) : null
        }
      </StartAudio>
    </main>
  );
}
