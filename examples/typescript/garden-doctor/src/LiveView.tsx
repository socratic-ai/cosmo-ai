import { useState } from 'react';
import { MicToggle, RealtimeAudio, StartAudio, useTransportState } from 'cosmo-ai';

import { useWakeLock } from './camera/use_wake_lock';
import { useDrawMarks } from './draw/use_draw_marks';
import CameraStage from './CameraStage';
import { CaptionStrip } from './CaptionStrip';
import { StatusPill } from './StatusPill';

type Props = {
  stream: MediaStream | null;
  mirrored: boolean;
  canFlip: boolean;
  onFlip: () => void;
  onEnd: () => void;
  warning: string | null;
};

export function LiveView({ stream, mirrored, canFlip, onFlip, onEnd, warning }: Props) {
  const transport = useTransportState();
  const { boxes, points } = useDrawMarks(true);
  const [showCaption, setShowCaption] = useState(true);
  useWakeLock(true);

  return (
    <div className="visit">
      {stream !== null && (
        <CameraStage stream={stream} mirrored={mirrored} boxes={boxes} points={points} />
      )}

      <div className="hud">
        <header className="hud-top">
          <StatusPill transport={transport} warning={warning} />
          {canFlip && (
            <button type="button" className="btn round" onClick={onFlip} aria-label="Switch camera">
              ⟲
            </button>
          )}
        </header>

        <footer className="hud-bottom">
          {showCaption && <CaptionStrip />}
          <div className="controls">
            <button
              type="button"
              className="btn round"
              onClick={() => setShowCaption((on) => !on)}
              aria-label={showCaption ? 'Hide captions' : 'Show captions'}
              aria-pressed={showCaption}
            >
              {showCaption ? '💬' : '🚫'}
            </button>
            <MicToggle
              className="btn"
              label={{ muted: 'Unmute', unmuted: 'Mute' }}
              onError={() => console.error('[garden-doctor] mic toggle failed')}
            />
            <button type="button" className="btn end" onClick={onEnd}>
              End the visit
            </button>
          </div>
        </footer>
      </div>
      <RealtimeAudio />
      <StartAudio>
        {({ blocked, start }) =>
          blocked ? (
            <button type="button" className="btn unlock" onClick={() => void start()}>
              Tap to hear the doctor
            </button>
          ) : null
        }
      </StartAudio>
    </div>
  );
}
