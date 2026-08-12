import { tool } from 'cosmo-ai/tool';
import { zodInput } from 'cosmo-ai/tool/zod';
import { z } from 'zod/v4';

import type { BoardOrientation, BoardVisionConfig } from './board_vision';
import { readBoardPosition } from './board_vision';
import type { FrameCapture } from './frame_capture';
import type { Referee } from './referee';

/** Everything the client tools need from the running app. `analyze_position`
 *  (client-side stockfish.wasm) will take the same context when it lands. */
export type ToolContext = {
  vision: BoardVisionConfig;
  getCapture: () => FrameCapture | null;
  referee: Referee;
  orientation?: BoardOrientation;
};

export function makeBoardPositionTool(ctx: ToolContext) {
  return tool({
    name: 'get_chess_board_position',
    description:
      'Read the chess board through the camera and return its FEN placement. ' +
      'You do NOT read the board yourself — your own reading of a board is ' +
      'unreliable. Call this whenever you need to know where the pieces are: ' +
      'to answer any question about the position, or when the streamed board ' +
      'state seems stale.',
    input: zodInput(
      z.object({
        orientation: z
          .enum(['white', 'black'])
          .optional()
          .describe(
            "Which side the board is seen from — 'white' if white's pieces are " +
              'nearest the camera. Omit if unsure; it is detected from the board.',
          ),
      }),
    ),
    handler: async ({ orientation }) => {
      const capture = ctx.getCapture();
      if (capture === null) {
        return {
          status: 'unreadable',
          coach_hint:
            "The camera isn't running — ask the user to point it at the board. " +
            'Do not guess the position.',
        };
      }
      const frame = await capture.capture();
      const result = await readBoardPosition(
        ctx.vision,
        frame,
        orientation ?? ctx.orientation,
      );
      if (result.status === 'ok' && ctx.referee.gameStarted) {
        return { ...result, side_to_move: ctx.referee.sideToMove };
      }
      return result;
    },
  });
}
