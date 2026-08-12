/**
 * Runs the real single-threaded lite wasm engine through the same UciEngine
 * client the browser uses; only the transport differs (the `stockfish`
 * package's Node loader instead of a Worker).
 *
 * One engine for the whole file: the Node loader's emscripten state is
 * per-process and a second init aborts, which also matches how the app
 * holds one engine per session.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { UciEngine, type UciTransport } from './engine';
import { analyzePosition } from './analyze_core';

async function createNodeTransport(): Promise<UciTransport> {
  const initEngine = (await import('stockfish')).default;
  const engine = await initEngine('lite-single');
  const listeners: Array<(line: string) => void> = [];
  engine.listener = (line: string) => {
    for (const listener of listeners) listener(line);
  };
  return {
    send: (command) => engine.sendCommand(command),
    onLine: (listener) => listeners.push(listener),
    // The Node loader turns `quit` into process.exit(), which would kill the
    // test process; the fork's teardown reaps the wasm instance instead.
    terminate: () => {},
  };
}

let engine: UciEngine;

beforeAll(async () => {
  engine = new UciEngine(await createNodeTransport());
}, 60_000);

afterAll(() => {
  engine.close();
});

describe('analyzePosition against real Stockfish', () => {
  it('finds mate in one', { timeout: 60_000 }, async () => {
    // Back-rank mate: Re8#.
    const result = await analyzePosition(
      engine,
      '6k1/5ppp/8/8/8/8/5PPP/4R1K1',
      'white',
    );
    expect(result.status).toBe('ok');
    expect(result.top_moves?.[0]?.move).toBe('Re8#');
    expect(result.top_moves?.[0]?.eval).toBe('mate in 1');
    expect(result.position_fen).toBe('6k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1');
    expect(result.coach_hint).toContain('Re8#');
  });

  it('returns three ranked moves with lines from the start position', {
    timeout: 60_000,
  }, async () => {
    const result = await analyzePosition(
      engine,
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR',
      'white',
    );
    expect(result.status).toBe('ok');
    expect(result.top_moves).toHaveLength(3);
    for (const move of result.top_moves ?? []) {
      expect(move.line[0]).toBe(move.move);
      expect(move.eval).toMatch(/^[+-]\d+\.\d{2}$/);
    }
    expect(result.side_to_move).toBe('white');
  });

  it('rejects an illegal placement without touching the engine', async () => {
    const result = await analyzePosition(
      engine,
      'rnbq1bnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR',
      'white',
    );
    expect(result.status).toBe('unreadable');
    expect(result.coach_hint).toContain('get_chess_board_position');
  });

  it('serializes concurrent calls on one engine', { timeout: 60_000 }, async () => {
    const [a, b] = await Promise.all([
      analyzePosition(engine, '6k1/5ppp/8/8/8/8/5PPP/4R1K1', 'white'),
      analyzePosition(
        engine,
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR',
        'black',
      ),
    ]);
    expect(a.top_moves?.[0]?.move).toBe('Re8#');
    expect(b.status).toBe('ok');
    expect(b.top_moves?.length).toBeGreaterThan(0);
  });
});
