import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import {
  MicToggle,
  RealtimeAudio,
  StartAudio,
  useRealtimeSessionContext,
  useTransportState,
} from 'cosmo-ai';

import { BoardFrame } from './board/BoardFrame';
import { CaptionStrip } from './CaptionStrip';
import type { GameStore } from './game/state';
import { StatusPill } from './StatusPill';

type Props = {
  store: GameStore;
  warning: string | null;
  onEnd: () => void;
};

export function LiveView({ store, warning, onEnd }: Props) {
  const transport = useTransportState();
  const session = useRealtimeSessionContext();
  const [micWarning, setMicWarning] = useState<string | null>(null);

  const game = useSyncExternalStore(
    useCallback((onChange: () => void) => store.subscribe(onChange), [store]),
    () => store.getState(),
  );

  // The buzzers: number keys map to teams in registration order. A press
  // locks the board and tells the MC who was first — as a context note, so
  // the room hears the host react, not a robot announcing.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const index = Number.parseInt(event.key, 10) - 1;
      const team = store.getState().teams[index];
      if (Number.isNaN(index) || team === undefined) return;
      const locked = store.setBuzzed(team.name);
      if (locked === null) return;
      session
        ?.sendContext(
          `[buzzer] ${locked} buzzed first — the buzzers are locked until clear_buzzer.`,
        )
        .catch((err) => console.error('[party-game-night] buzz context failed', err));
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [store, session]);

  const onBoardEvent = useCallback(
    (event: string) => {
      if (event !== 'prompt-timer-finished') return;
      session
        ?.sendContext('[board] The acting timer just ran out — call the round.')
        .catch((err) => console.error('[party-game-night] board context failed', err));
    },
    [session],
  );

  const buzzersOpen = game.stage?.kind === 'quiz' && game.stage.buzzed === null;

  return (
    <div className="show">
      <header className="show-top">
        <StatusPill transport={transport} warning={warning ?? micWarning} />
        <div className="controls">
          <MicToggle
            className="btn"
            label={{ muted: 'Unmute', unmuted: 'Mute' }}
            onError={() => {
              console.error('[party-game-night] mic toggle failed');
              setMicWarning('The mic did not switch — check browser permissions.');
            }}
          />
          <button type="button" className="btn end" onClick={onEnd}>
            End the show
          </button>
        </div>
      </header>

      <BoardFrame store={store} onBoardEvent={onBoardEvent} />

      <footer className="show-bottom">
        {buzzersOpen && (
          <p className="buzz-hint">
            {game.teams.map((team, i) => `${i + 1} = ${team.name}`).join(' · ')}
          </p>
        )}
        <CaptionStrip />
      </footer>

      <RealtimeAudio />
      <StartAudio>
        {({ blocked, start }) =>
          blocked ? (
            <button type="button" className="btn unlock" onClick={() => void start()}>
              Tap to hear the host
            </button>
          ) : null
        }
      </StartAudio>
    </div>
  );
}
