/**
 * Shared coalescing logic for realtime transcript bubbles.
 *
 * A spoken turn arrives as a stream of deltas — streaming fragments followed
 * by a cumulative final. Two things make "which bubble does this delta belong
 * to?" subtle:
 *
 *  - Under barge-in the two sides interleave: the wire order becomes
 *    user-partial → assistant-deltas → user-final, so a turn's final is not
 *    adjacent to its own partial.
 *  - ``turn-complete`` (which advances the client's ``turnId``) can arrive
 *    between a speaker's streaming partials and its cumulative final, so the
 *    two halves of one turn carry different turnIds.
 *
 * Coalescing by arrival adjacency splits the first case; coalescing by
 * ``(turnId, role)`` splits the second. Coalescing by the most recent still
 * open bubble for the delta's role is robust to both: a turn's bubble stays
 * open until its ``isFinal`` delta closes it, and there is at most one open
 * bubble per role at a time.
 *
 * Kept provider- and framework-agnostic so the app store and the SDK's React
 * reducer share one implementation and cannot drift.
 */

/** Minimal bubble shape the fold needs; callers layer id/turnId/timestamp on. */
export type TranscriptFoldBubble = {
  role: string;
  isFinal: boolean;
};

/**
 * Index of the open (non-final) bubble a same-role delta folds into, or -1 to
 * start a new bubble. Scans from the end and stops at the most recent bubble
 * of ``role``: fold when it is still open, start fresh when it is closed (that
 * turn is done) or when the role has no bubble yet.
 */
export function openBubbleIndex(
  bubbles: ReadonlyArray<TranscriptFoldBubble>,
  role: string,
): number {
  for (let i = bubbles.length - 1; i >= 0; i--) {
    const bubble = bubbles[i];
    if (bubble === undefined || bubble.role !== role) continue;
    return bubble.isFinal ? -1 : i;
  }
  return -1;
}

/**
 * Merge a delta's text into an existing bubble per the ``TranscriptDeltaEvent``
 * wire contract: a streaming delta (``isFinal=false``) is a fragment to append;
 * the final (``isFinal=true``) is the cumulative full text, which replaces the
 * accumulation so a single dropped fragment cannot corrupt the finished turn.
 */
export function foldDeltaText(existing: string, deltaText: string, isFinal: boolean): string {
  return isFinal ? deltaText : existing + deltaText;
}

/**
 * A delta carrying no visible text (empty or whitespace-only) must not open a
 * new bubble — e.g. the empty final that force-closes a garbled/silent turn
 * would otherwise render as a blank bubble. (It still folds into — and closes —
 * an already-open bubble; this only gates *creating* one.)
 */
export function isBlankDelta(text: string): boolean {
  return text.trim().length === 0;
}
