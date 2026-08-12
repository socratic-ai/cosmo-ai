/**
 * Position legality and coach-facing formatting, mirroring the contract of
 * the Cosmo backend's `start_chess_analysis` tool: a FEN placement is
 * untrusted input (it round-trips through the model), so it is validated
 * before it reaches the engine, and engine output is rendered into the same
 * speakable shapes (`+0.45`, `mate in 2`, capture annotations, a short
 * expected line).
 */

import { Chess, validateFen } from 'chess.js';

export type SideToMove = 'white' | 'black';

export type TopMove = {
  rank: number;
  /** SAN, human-readable, e.g. "Nf3". */
  move: string;
  /** "+0.45", "-1.20", or "mate in 2". */
  eval: string;
  /** Expected continuation in SAN, starting with `move` itself. */
  line: string[];
};

/** Plies of the engine line kept for coaching: two moves each side. */
export const PV_PLIES = 4;

export function fullFen(placement: string, sideToMove: SideToMove): string {
  const board = placement.trim().split(/\s+/)[0];
  return `${board} ${sideToMove === 'white' ? 'w' : 'b'} - - 0 1`;
}

/**
 * Human-readable reason the FEN is not a legal position, or null if legal.
 *
 * Mirrors the backend's `describe_invalidity`. chess.js's `validateFen`
 * covers syntax, kings, and pawns on the edge ranks; on top of that come
 * the piece-count checks and the impossible-position check (the side NOT
 * to move already in check). Wasm Stockfish misbehaves on illegal
 * positions, so this runs before every search.
 */
export function describeInvalidity(fen: string): string | null {
  const structural = validateFen(fen);
  if (!structural.ok) return structural.error ?? 'the FEN is not valid';

  const board = fen.split(/\s+/)[0];
  const count = (re: RegExp) => (board.match(re) ?? []).length;
  const reasons: string[] = [];
  if (count(/P/g) > 8) reasons.push('too many white pawns');
  if (count(/p/g) > 8) reasons.push('too many black pawns');
  if (count(/[A-Z]/g) > 16) reasons.push('too many white pieces');
  if (count(/[a-z]/g) > 16) reasons.push('too many black pieces');
  if (reasons.length > 0) return reasons.join('; ');

  try {
    new Chess(fen);
  } catch (error) {
    return `the FEN doesn't parse (${(error as Error).message})`;
  }
  // A position where the side NOT to move is already in check cannot occur
  // in a real game. chess.js only exposes check for the side to move, so
  // flip the turn and ask again.
  const flipped = fen.replace(/ (w|b) /, (m) => (m === ' w ' ? ' b ' : ' w '));
  try {
    if (new Chess(flipped).isCheck()) {
      return (
        'the side NOT to move is in check, which is impossible on this turn — ' +
        're-check the kings and the pieces attacking them'
      );
    }
  } catch {
    // The flipped position can be unloadable for reasons the real one is
    // not; the original parsed, so let the engine have it.
  }
  return null;
}

/** Mirrors the backend's eval rendering: mate folded to words, cp to pawns. */
export function formatEval(scoreCp: number, mateIn: number | null): string {
  if (mateIn !== null) {
    return `mate in ${Math.abs(mateIn)}` + (mateIn > 0 ? '' : ' (against)');
  }
  const pawns = scoreCp / 100;
  return `${pawns >= 0 ? '+' : ''}${pawns.toFixed(2)}`;
}

/**
 * Renders a UCI principal variation as SAN, played out on a copy, truncated
 * to `PV_PLIES` — a coach uses the next couple of moves for each side, and a
 * 20-ply line is noise the model would read aloud.
 */
export function pvToSan(fen: string, pv: string[]): string[] {
  const replay = new Chess(fen);
  const line: string[] = [];
  for (const uci of pv.slice(0, PV_PLIES)) {
    try {
      const move = replay.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci.length > 4 ? uci.slice(4) : undefined,
      });
      line.push(move.san);
    } catch {
      break;
    }
  }
  return line;
}

const PIECE_NAMES: Record<string, string> = {
  p: 'pawn',
  n: 'knight',
  b: 'bishop',
  r: 'rook',
  q: 'queen',
  k: 'king',
};

/**
 * Renders the moves, naming the captured piece + square for any capture, so
 * the model coaches from ground truth instead of guessing what it can take.
 */
export function annotateMoves(fen: string, moves: TopMove[]): string {
  const parts: string[] = [];
  for (const m of moves) {
    let label = `${m.move} (${m.eval})`;
    try {
      const position = new Chess(fen);
      const played = position.move(m.move);
      if (played.isEnPassant()) {
        label += ' — captures a pawn en passant';
      } else if (played.captured) {
        label += ` — captures the ${PIECE_NAMES[played.captured]} on ${played.to}`;
      }
    } catch {
      // An unplayable SAN just goes unannotated.
    }
    // The continuation is what turns "Nf3 is best" into something coachable:
    // it names the reply the student should be looking for.
    if (m.line.length > 1) {
      label += ` — expect ${m.line.join(' ')}`;
    }
    parts.push(label);
  }
  return parts.join('; ');
}
