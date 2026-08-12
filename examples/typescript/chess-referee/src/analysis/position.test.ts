import { describe, expect, it } from 'vitest';

import { parseInfoLine, MATE_SCORE } from './engine';
import {
  annotateMoves,
  describeInvalidity,
  formatEval,
  fullFen,
  pvToSan,
} from './position';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';

describe('fullFen', () => {
  it('appends side to move and neutral counters', () => {
    expect(fullFen(START, 'white')).toBe(`${START} w - - 0 1`);
    expect(fullFen(START, 'black')).toBe(`${START} b - - 0 1`);
  });

  it('keeps only the placement field of a full FEN', () => {
    expect(fullFen(`${START} w KQkq - 4 12`, 'black')).toBe(`${START} b - - 0 1`);
  });
});

describe('describeInvalidity', () => {
  it('accepts the start position', () => {
    expect(describeInvalidity(fullFen(START, 'white'))).toBeNull();
  });

  it('rejects garbage', () => {
    expect(describeInvalidity('not a fen')).toBeTruthy();
  });

  it('rejects a missing king', () => {
    expect(
      describeInvalidity('rnbq1bnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1'),
    ).toMatch(/king/);
  });

  it('rejects a pawn on the back rank', () => {
    expect(
      describeInvalidity('Pnbqkbnr/1ppppppp/8/8/8/8/PPPPPPP1/RNBQKBNR w - - 0 1'),
    ).toMatch(/pawn/);
  });

  it('rejects too many pawns', () => {
    expect(
      describeInvalidity('rnbqkbnr/pppppppp/p7/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1'),
    ).toContain('too many black pawns');
  });

  it('rejects the side NOT to move being in check', () => {
    // White queen on e7 checks the black king, but it is white to move.
    expect(
      describeInvalidity('rnb1kbnr/ppppQppp/8/8/8/8/PPPP1PPP/RNB1KBNR w - - 0 1'),
    ).toContain('side NOT to move is in check');
  });

  it('accepts the side to move being in check', () => {
    expect(
      describeInvalidity('rnb1kbnr/ppppQppp/8/8/8/8/PPPP1PPP/RNB1KBNR b - - 0 1'),
    ).toBeNull();
  });
});

describe('formatEval', () => {
  it('renders centipawns as signed pawns', () => {
    expect(formatEval(45, null)).toBe('+0.45');
    expect(formatEval(-120, null)).toBe('-1.20');
    expect(formatEval(0, null)).toBe('+0.00');
  });

  it('renders mate for and against', () => {
    expect(formatEval(MATE_SCORE - 2, 2)).toBe('mate in 2');
    expect(formatEval(-MATE_SCORE + 3, -3)).toBe('mate in 3 (against)');
  });
});

describe('pvToSan', () => {
  it('converts and truncates to four plies', () => {
    const fen = fullFen(START, 'white');
    expect(pvToSan(fen, ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5'])).toEqual([
      'e4',
      'e5',
      'Nf3',
      'Nc6',
    ]);
  });

  it('handles promotion moves', () => {
    const fen = '8/2P3k1/8/8/8/8/6K1/8 w - - 0 1';
    expect(pvToSan(fen, ['c7c8q'])).toEqual(['c8=Q']);
  });

  it('stops at the first unplayable move', () => {
    const fen = fullFen(START, 'white');
    expect(pvToSan(fen, ['e2e4', 'e2e4'])).toEqual(['e4']);
  });
});

describe('annotateMoves', () => {
  it('names the captured piece and square', () => {
    // White to move, black pawn hanging on d5.
    const fen = 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w - - 0 1';
    const text = annotateMoves(fen, [
      { rank: 1, move: 'exd5', eval: '+0.50', line: ['exd5', 'Qxd5'] },
    ]);
    expect(text).toContain('captures the pawn on d5');
    expect(text).toContain('expect exd5 Qxd5');
  });

  it('names en passant captures', () => {
    const fen = 'rnbqkbnr/ppp1pppp/8/8/3pP3/8/PPPP1PPP/RNBQKBNR b - e3 0 1';
    const text = annotateMoves(fen, [
      { rank: 1, move: 'dxe3', eval: '+0.10', line: ['dxe3'] },
    ]);
    expect(text).toContain('captures a pawn en passant');
  });
});

describe('parseInfoLine', () => {
  it('parses a cp line', () => {
    const line =
      'info depth 15 seldepth 21 multipv 2 score cp 34 nodes 1000 pv e2e4 e7e5';
    expect(parseInfoLine(line)).toEqual({
      multipv: 2,
      depth: 15,
      scoreCp: 34,
      mateIn: null,
      pv: ['e2e4', 'e7e5'],
    });
  });

  it('parses a mate line and folds the score', () => {
    const line = 'info depth 10 multipv 1 score mate -2 pv e2e4';
    const parsed = parseInfoLine(line);
    expect(parsed?.mateIn).toBe(-2);
    expect(parsed?.scoreCp).toBe(-MATE_SCORE + 2);
  });

  it('ignores lines without a pv', () => {
    expect(parseInfoLine('info depth 5 currmove e2e4')).toBeNull();
    expect(parseInfoLine('bestmove e2e4')).toBeNull();
  });
});
