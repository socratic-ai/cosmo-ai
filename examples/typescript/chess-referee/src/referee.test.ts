import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';

import { placementOf, Referee, START_PLACEMENT, type RefereeEvent } from './referee';

/** Feed one placement enough times to clear the stability gate. */
function feedStable(referee: Referee, placement: string, threshold = 2): RefereeEvent | null {
  let event: RefereeEvent | null = null;
  for (let i = 0; i < threshold; i++) {
    event = referee.ingest(placement);
  }
  return event;
}

function placementAfter(moves: string[]): string {
  const chess = new Chess();
  for (const san of moves) chess.move(san);
  return placementOf(chess.fen());
}

function startGame(referee: Referee): void {
  expect(feedStable(referee, START_PLACEMENT)).toEqual({ kind: 'game_started' });
}

describe('stability gate', () => {
  it('ignores a placement seen fewer times than the threshold', () => {
    const referee = new Referee(3);
    expect(referee.ingest(START_PLACEMENT)).toBeNull();
    expect(referee.ingest(START_PLACEMENT)).toBeNull();
    expect(referee.ingest(START_PLACEMENT)).toEqual({ kind: 'game_started' });
  });

  it('resets the count when the read flickers', () => {
    const referee = new Referee(2);
    expect(referee.ingest(START_PLACEMENT)).toBeNull();
    expect(referee.ingest('8/8/8/8/8/8/8/8')).toBeNull();
    expect(referee.ingest(START_PLACEMENT)).toBeNull();
    expect(referee.ingest(START_PLACEMENT)).toEqual({ kind: 'game_started' });
  });

  it('fires once per stable position, not on every following read', () => {
    const referee = new Referee(2);
    startGame(referee);
    expect(referee.ingest(START_PLACEMENT)).toBeNull();
  });
});

describe('move inference', () => {
  it('recognizes a legal move with its SAN and mover', () => {
    const referee = new Referee(2);
    startGame(referee);
    const event = feedStable(referee, placementAfter(['e4']));
    expect(event).toMatchObject({ kind: 'legal_move', san: 'e4', mover: 'white' });
    expect(referee.sideToMove).toBe('black');
  });

  it('follows a full sequence including a capture', () => {
    const referee = new Referee(2);
    startGame(referee);
    const moves: string[] = [];
    for (const san of ['e4', 'd5', 'exd5']) {
      moves.push(san);
      const event = feedStable(referee, placementAfter(moves));
      expect(event).toMatchObject({ kind: 'legal_move', san });
    }
  });

  it('recognizes castling as one move despite two pieces changing', () => {
    const referee = new Referee(2);
    startGame(referee);
    const moves: string[] = [];
    for (const san of ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'O-O']) {
      moves.push(san);
      const event = feedStable(referee, placementAfter(moves));
      expect(event).toMatchObject({ kind: 'legal_move', san });
    }
  });

  it('flags a legal move played by the wrong side without advancing the game', () => {
    const referee = new Referee(2);
    startGame(referee);
    feedStable(referee, placementAfter(['e4']));
    // White moves again instead of black.
    const chess = new Chess();
    chess.move('e4');
    const fenParts = chess.fen().split(' ');
    fenParts[1] = 'w';
    fenParts[3] = '-';
    const white2 = new Chess(fenParts.join(' '));
    white2.move('Nf3');
    const event = feedStable(referee, placementOf(white2.fen()));
    expect(event).toMatchObject({ kind: 'out_of_turn', san: 'Nf3', mover: 'white' });
    expect(referee.sideToMove).toBe('black');
  });

  it('flags an unreachable small change as an illegal move', () => {
    const referee = new Referee(2);
    startGame(referee);
    // The b1 knight teleports to b3 — no legal knight move from the start.
    const observed = 'rnbqkbnr/pppppppp/8/8/8/1N6/PPPPPPPP/R1BQKBNR';
    const event = feedStable(referee, observed);
    expect(event).toMatchObject({ kind: 'illegal_move', observed });
    if (event?.kind === 'illegal_move') {
      expect(event.description).toContain('b1');
      expect(event.description).toContain('b3');
    }
    expect(referee.placement).toBe(START_PLACEMENT);
  });

  it('rules a many-square change a scrambled board', () => {
    const referee = new Referee(2);
    startGame(referee);
    const event = feedStable(referee, '8/8/8/8/8/8/8/8');
    expect(event).toMatchObject({ kind: 'board_scrambled' });
  });
});

describe('game lifecycle', () => {
  it('stays silent before the starting position appears', () => {
    const referee = new Referee(2);
    expect(feedStable(referee, placementAfter(['e4']))).toBeNull();
    expect(referee.gameStarted).toBe(false);
  });

  it('startNewGame resets state and waits for a fresh start', () => {
    const referee = new Referee(2);
    startGame(referee);
    feedStable(referee, placementAfter(['e4']));
    referee.startNewGame();
    expect(referee.gameStarted).toBe(false);
    expect(feedStable(referee, START_PLACEMENT)).toEqual({ kind: 'game_started' });
  });
});
