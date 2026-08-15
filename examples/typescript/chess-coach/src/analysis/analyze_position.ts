/**
 * `analyze_position` — a pure client tool over {@link analyzePosition}: FEN
 * placement in (passed through from `get_chess_board_position`, never
 * model-authored), top moves with eval and expected line out. Stockfish runs
 * in a web worker on this machine; no backend round-trip.
 */

import { tool } from 'cosmo-ai/tool';
import { zodInput } from 'cosmo-ai/tool/zod';
import { z } from 'zod/v4';

import { analyzePosition } from './analyze_core';
import type { UciEngine } from './engine';
import { analysisEngine } from './stockfish_transport';

export function makeAnalyzePositionTool(getEngine: () => UciEngine = analysisEngine) {
  return tool({
    name: 'analyze_position',
    description:
      "Get the chess engine's strongest moves for a position you already read " +
      'with get_chess_board_position. Pass that placement through unchanged, ' +
      'plus whose turn it is — side_to_move is the player ON MOVE, not the ' +
      'colour the user plays. Returns the moves directly. Coach from them ' +
      'conversationally; never recite raw lines.',
    input: zodInput(
      z.object({
        position: z
          .string()
          .describe(
            'The FEN placement returned by get_chess_board_position, passed ' +
              'through unchanged. Never write this yourself and never edit it.',
          ),
        side_to_move: z
          .enum(['white', 'black'])
          .describe(
            'Whose turn it is in this position — NOT which color the user ' +
              "plays. If the user just moved it is their opponent's turn.",
          ),
      }),
    ),
    handler: async ({ position, side_to_move }) =>
      analyzePosition(getEngine(), position, side_to_move),
  });
}
