import { tool } from 'cosmo-ai/tool';
import { zodInput } from 'cosmo-ai/tool/zod';
import { z } from 'zod/v4';

import type { BoardOrientation, BoardVisionConfig } from './board_vision';
import { readBoardPosition } from './board_vision';
import type { FrameCapture } from './frame_capture';

/** Everything the board-vision client tool needs from the running app.
 *  `analyze_position` (client-side stockfish.wasm) is self-contained. */
export type ToolContext = {
  vision: BoardVisionConfig;
  getCapture: () => FrameCapture | null;
  orientation?: BoardOrientation;
};

export function makeBoardPositionTool(ctx: ToolContext) {
  return tool({
    name: 'get_chess_board_position',
    description:
      'Read the chess board on the shared screen and return its FEN placement. ' +
      'You do NOT read the board yourself — your own reading of a board is ' +
      'unreliable. Call this whenever you need to know where the pieces are: ' +
      'before analyzing, after a move, or to answer any question about the ' +
      'position. Pass the placement it returns to analyze_position unchanged.',
    input: zodInput(
      z.object({
        orientation: z
          .enum(['white', 'black'])
          .optional()
          .describe(
            "Which side the board is drawn from — 'white' if white's pieces are " +
              'along the bottom. Omit if unsure; it is detected from the board.',
          ),
      }),
    ),
    handler: async ({ orientation }) => {
      const capture = ctx.getCapture();
      if (capture === null) {
        return {
          status: 'unreadable',
          coach_hint:
            "The screen share isn't running — ask the user to share the tab with " +
            'their board. ' +
            'Do not guess the position.',
        };
      }
      const frame = await capture.capture();
      return readBoardPosition(ctx.vision, frame, orientation ?? ctx.orientation);
    },
  });
}
