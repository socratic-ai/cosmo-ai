import { foldDeltaText, isBlankDelta, openBubbleIndex } from './transcript_fold';
import type { TranscriptDeltaEvent } from './events';

export type RealtimeTranscriptItem = {
  id: string;
  turnId: string;
  role: 'user' | 'assistant';
  text: string;
  isFinal: boolean;
};

/** Fold a transcript event into the accumulated bubbles.
 *
 * Coalesces by role identity — the open same-role bubble — rather than the
 * event's ``append`` hint or a ``(turnId, role)`` key, both of which split a
 * turn under interleaving (barge-in) or when ``turn-complete`` advances the
 * turnId between a speaker's partials and its final. ``isFinal`` carries the
 * cumulative full transcript (replace); a streaming event carries only the new
 * fragment (append). See ``transcript_fold``. */
export function reduceTranscript(
  current: RealtimeTranscriptItem[],
  event: TranscriptDeltaEvent,
  maxLength: number,
): RealtimeTranscriptItem[] {
  const idx = openBubbleIndex(current, event.role);
  const entry = idx === -1 ? undefined : current[idx];
  if (entry !== undefined) {
    const updated = [...current];
    updated[idx] = {
      ...entry,
      text: foldDeltaText(entry.text, event.text, event.isFinal),
      // ``entry`` is the open (non-final) bubble, so its ``isFinal`` is false;
      // the delta's flag alone decides whether this closes the turn.
      isFinal: event.isFinal,
    };
    return updated;
  }
  // No open bubble for this role. Don't materialize one for a blank delta
  // (e.g. a turn-start/keepalive marker) — it would render as a blank bubble.
  if (isBlankDelta(event.text)) return current;
  const next: RealtimeTranscriptItem = {
    id: event.id,
    turnId: event.turnId,
    role: event.role,
    text: event.text,
    isFinal: event.isFinal,
  };
  const appended = [...current, next];
  if (!Number.isFinite(maxLength) || appended.length <= maxLength) return appended;
  return appended.slice(-maxLength);
}
