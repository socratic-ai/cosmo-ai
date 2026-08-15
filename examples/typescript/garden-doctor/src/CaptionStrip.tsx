import { useTranscript } from 'cosmo-ai';

// A turn is one transcript item however long it runs, so a talkative answer
// would grow the caption until it covered the camera. Keep the most recent
// words, which are the ones being spoken now.
const MAX_CHARS = 180;

function tail(text: string): string {
  return text.length <= MAX_CHARS ? text : `…${text.slice(-MAX_CHARS)}`;
}

/** The latest thing said, as one live caption — the doctor's words full
 *  size, the user's own (interim) speech dimmer. */
export function CaptionStrip() {
  const transcript = useTranscript();
  const last = transcript[transcript.length - 1];

  if (last === undefined) {
    return <p className="caption hint">Point at a plant and ask the doctor anything…</p>;
  }
  const you = last.role === 'user';
  return (
    <p className={`caption${you ? ' you' : ''}${last.isFinal ? '' : ' partial'}`}>
      {you ? `You: ${tail(last.text)}` : tail(last.text)}
    </p>
  );
}
