import { useTranscript } from 'cosmo-ai';

// A turn is one transcript item however long it runs; keep the most recent
// words, which are the ones being spoken now.
const MAX_CHARS = 180;

function tail(text: string): string {
  return text.length <= MAX_CHARS ? text : `…${text.slice(-MAX_CHARS)}`;
}

/** The latest thing said, as one live caption — the host's words full size,
 *  the room's own (interim) speech dimmer. */
export function CaptionStrip() {
  const transcript = useTranscript();
  const last = transcript[transcript.length - 1];

  if (last === undefined) {
    return <p className="caption hint">Say hi to your host — and pick your teams…</p>;
  }
  const room = last.role === 'user';
  return (
    <p className={`caption${room ? ' you' : ''}${last.isFinal ? '' : ' partial'}`}>
      {room ? `Room: ${tail(last.text)}` : tail(last.text)}
    </p>
  );
}
