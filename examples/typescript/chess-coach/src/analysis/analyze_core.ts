/**
 * Client-side position analysis: Stockfish runs in a web worker on the
 * user's machine, no backend round-trip. The result mirrors the Cosmo
 * backend's `start_chess_analysis` tool so agent instructions written
 * against either work unchanged.
 */

import { EngineError, UciEngine } from './engine';
import {
  annotateMoves,
  describeInvalidity,
  formatEval,
  fullFen,
  pvToSan,
  type SideToMove,
  type TopMove,
} from './position';

/**
 * Coaching wants bounded latency, not a fixed depth (which can spike past a
 * second on sharp positions). Single-threaded lite wasm reaches the ~depth
 * 12–15 a coach needs well inside this budget.
 */
const MOVETIME_MS = 750;
const TOP_N = 3;

export type AnalyzePositionResult = {
  status: 'ok' | 'unreadable' | 'error';
  side_to_move?: SideToMove;
  top_moves?: TopMove[];
  coach_hint: string;
  position_fen?: string;
};

export async function analyzePosition(
  engine: UciEngine,
  position: string,
  sideToMove: SideToMove,
): Promise<AnalyzePositionResult> {
  // The placement came from get_chess_board_position, but it arrives back
  // through the model, so it is untrusted input: validate before handing it
  // to the engine.
  const fen = fullFen(position, sideToMove);
  const flaw = describeInvalidity(fen);
  if (flaw !== null) {
    console.warn('analyze_position: invalid position', { flaw });
    return {
      status: 'error',
      coach_hint:
        "The placement you passed isn't a legal position, so the board was " +
        'not misread — you altered it. Call get_chess_board_position and pass ' +
        'its placement through byte for byte. Do not tell the user anything ' +
        'is wrong with their board.',
    };
  }

  let engineLines;
  try {
    engineLines = await engine.analyze(fen, MOVETIME_MS);
  } catch (error) {
    console.error('analyze_position: engine failed', error);
    return {
      status: 'error',
      coach_hint:
        error instanceof EngineError
          ? 'My chess engine is unavailable — coach from general principles for now.'
          : 'I had trouble analyzing — coach from general principles for now.',
    };
  }

  const topMoves: TopMove[] = [];
  for (const line of engineLines.slice(0, TOP_N)) {
    const san = pvToSan(fen, line.pv);
    if (san.length === 0) continue;
    topMoves.push({
      rank: topMoves.length + 1,
      move: san[0],
      eval: formatEval(line.scoreCp, line.mateIn),
      line: san,
    });
  }
  return {
    status: 'ok',
    side_to_move: sideToMove,
    top_moves: topMoves,
    coach_hint: annotateMoves(fen, topMoves),
    // The full FEN tells the model what is actually on each square (e.g.
    // which piece a capturing move wins) instead of it guessing from its own
    // reading of the screen.
    position_fen: fen,
  };
}
