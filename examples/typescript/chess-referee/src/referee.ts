import { Chess } from 'chess.js';

/** What the referee concluded from a stable board change. */
export type RefereeEvent =
  /** The game began: the starting position was recognized. */
  | { kind: 'game_started' }
  /** A legal move was played. `fen` is the full FEN after the move. */
  | { kind: 'legal_move'; san: string; mover: 'white' | 'black'; fen: string }
  /** The observed position is not reachable by any legal move. */
  | { kind: 'illegal_move'; description: string; observed: string }
  /** A legal move — but by the side whose turn it isn't. */
  | { kind: 'out_of_turn'; san: string; mover: 'white' | 'black' }
  /** Pieces changed in a way no single move explains (knocked pieces,
   *  mid-move hand, takeback). */
  | { kind: 'board_scrambled'; observed: string };

export const START_PLACEMENT = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';

export function placementOf(fen: string): string {
  return fen.split(' ')[0];
}

type Grid = (string | null)[][];

/** Expand a FEN placement into an 8×8 grid; row 0 is rank 8. */
function gridOf(placement: string): Grid | null {
  const ranks = placement.split('/');
  if (ranks.length !== 8) return null;
  const grid: Grid = [];
  for (const rank of ranks) {
    const row: (string | null)[] = [];
    for (const ch of rank) {
      if (ch >= '1' && ch <= '8') {
        for (let i = 0; i < Number(ch); i++) row.push(null);
      } else {
        row.push(ch);
      }
    }
    if (row.length !== 8) return null;
    grid.push(row);
  }
  return grid;
}

function squareName(row: number, col: number): string {
  return `${String.fromCharCode(97 + col)}${8 - row}`;
}

function pieceName(fenChar: string): string {
  const color = fenChar === fenChar.toUpperCase() ? 'white' : 'black';
  const names: Record<string, string> = {
    p: 'pawn', r: 'rook', n: 'knight', b: 'bishop', q: 'queen', k: 'king',
  };
  return `${color} ${names[fenChar.toLowerCase()] ?? 'piece'}`;
}

function changedSquares(before: Grid, after: Grid): { row: number; col: number }[] {
  const diffs: { row: number; col: number }[] = [];
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      if (before[row][col] !== after[row][col]) diffs.push({ row, col });
    }
  }
  return diffs;
}

function describeIllegalChange(
  diffs: { row: number; col: number }[],
  before: Grid,
  after: Grid,
): string {
  const vacated: { square: string; piece: string }[] = [];
  const arrived: { square: string; piece: string }[] = [];
  for (const { row, col } of diffs) {
    const square = squareName(row, col);
    const was = before[row][col];
    const now = after[row][col];
    if (was !== null && now === null) vacated.push({ square, piece: was });
    if (now !== null && was !== now) arrived.push({ square, piece: now });
  }
  const from = vacated[0];
  const to = arrived[0];
  if (from && to) {
    return `${pieceName(from.piece)} from ${from.square} to ${to.square} — not a legal move here`;
  }
  const squares = diffs.map((d) => squareName(d.row, d.col)).join(', ');
  return `position changed on ${squares} in a way no legal move allows`;
}

/** Turns a stream of noisy board reads into confident game events.
 *
 *  Two jobs: a stability gate (a placement must be read identically on
 *  `stabilityThreshold` consecutive reads before it counts), and move
 *  inference — diff the accepted placement against the game state and find
 *  the legal move that explains it, or rule the change illegal.
 *
 *  Reads arrive already oriented (white's back rank last) — the vision
 *  endpoint resolves board orientation before we see the placement.
 */
export class Referee {
  private chess = new Chess();
  private started = false;
  private pending: string | null = null;
  private pendingCount = 0;

  constructor(private readonly stabilityThreshold: number = 2) {}

  get fen(): string {
    return this.chess.fen();
  }

  get placement(): string {
    return placementOf(this.chess.fen());
  }

  get sideToMove(): 'white' | 'black' {
    return this.chess.turn() === 'w' ? 'white' : 'black';
  }

  get gameStarted(): boolean {
    return this.started;
  }

  /** Reset to a fresh game; events resume once the starting position is
   *  recognized again. */
  startNewGame(): void {
    this.chess = new Chess();
    this.started = false;
    this.pending = null;
    this.pendingCount = 0;
  }

  /** Feed one read's placement. Returns an event only when a stable,
   *  *changed* position was accepted and classified. */
  ingest(placement: string): RefereeEvent | null {
    if (placement === this.pending) {
      this.pendingCount += 1;
    } else {
      this.pending = placement;
      this.pendingCount = 1;
    }
    if (this.pendingCount !== this.stabilityThreshold) return null;

    if (!this.started) {
      if (placement === START_PLACEMENT) {
        this.started = true;
        return { kind: 'game_started' };
      }
      return null;
    }

    if (placement === this.placement) return null;
    return this.classify(placement);
  }

  private classify(observed: string): RefereeEvent {
    const san = this.legalMoveExplaining(observed, this.chess.fen());
    if (san !== null) {
      const mover = this.sideToMove;
      this.chess.move(san);
      return { kind: 'legal_move', san, mover, fen: this.chess.fen() };
    }

    // A legal move for the *other* side? That's a real board event worth
    // calling out differently: someone moved out of turn. The game state
    // stays where it was — the move needs to be taken back.
    const toggled = this.toggledSideFen();
    if (toggled !== null) {
      const sanOther = this.legalMoveExplaining(observed, toggled);
      if (sanOther !== null) {
        const mover = this.sideToMove === 'white' ? 'black' : 'white';
        return { kind: 'out_of_turn', san: sanOther, mover };
      }
    }

    // No single legal move explains the change. A 1–4 square diff reads as
    // an attempted (illegal) move; anything bigger is a scrambled board.
    const before = gridOf(this.placement);
    const after = gridOf(observed);
    if (before === null || after === null) {
      return { kind: 'board_scrambled', observed };
    }
    const diffs = changedSquares(before, after);
    if (diffs.length < 1 || diffs.length > 4) {
      return { kind: 'board_scrambled', observed };
    }
    return {
      kind: 'illegal_move',
      description: describeIllegalChange(diffs, before, after),
      observed,
    };
  }

  /** Search every legal move of `fen`'s side to move for one whose resulting
   *  placement matches `observed`. Promotions are separate verbose moves, so
   *  every promotion piece is covered. */
  private legalMoveExplaining(observed: string, fen: string): string | null {
    const base = new Chess(fen);
    for (const move of base.moves({ verbose: true })) {
      const candidate = new Chess(fen);
      candidate.move(move.san);
      if (placementOf(candidate.fen()) === observed) return move.san;
    }
    return null;
  }

  /** Current position with the side to move flipped and en passant cleared,
   *  or null when the flip is not a valid position (e.g. the mover left the
   *  opponent in check). */
  private toggledSideFen(): string | null {
    const parts = this.chess.fen().split(' ');
    parts[1] = parts[1] === 'w' ? 'b' : 'w';
    parts[3] = '-';
    const fen = parts.join(' ');
    try {
      new Chess(fen);
      return fen;
    } catch {
      return null;
    }
  }
}
