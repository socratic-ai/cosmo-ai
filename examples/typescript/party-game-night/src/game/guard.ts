import { preToolUse, type Hook } from 'cosmo-ai';

import { MAX_STRIKES, type GameStore } from './state';

/**
 * House rules as PreToolUse hooks: the MC physically cannot flip an answer
 * nobody guessed twice, flip past the board, or strike a finished round.
 * A denial's reason goes back to the model as the tool outcome, so the MC
 * recovers in character instead of the board glitching.
 */
export function makeHouseRules(store: GameStore): Hook[] {
  const revealGuard = preToolUse(
    (ctx) => {
      const board = store.board();
      if (board === null) {
        return {
          permission: 'deny',
          reason: 'No feud board is showing — render_ui a feud_board first.',
        };
      }
      const n = ctx.arguments['number'];
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > board.answers.length) {
        return {
          permission: 'deny',
          reason: `This board has answers 1–${board.answers.length}.`,
        };
      }
      if (board.answers[n - 1].revealed) {
        return {
          permission: 'deny',
          reason: `Answer ${n} is already face-up. Flip a different one, or move the round along.`,
        };
      }
      return { permission: 'allow' };
    },
    { matcher: 'reveal_answer' },
  );

  const strikeGuard = preToolUse(
    () => {
      const board = store.board();
      if (board === null) {
        return { permission: 'deny', reason: 'No feud board is showing — strikes belong to a round.' };
      }
      if (board.strikes >= MAX_STRIKES) {
        return {
          permission: 'deny',
          reason: 'That was already the third strike — the round is over. Reveal the rest or move on.',
        };
      }
      return { permission: 'allow' };
    },
    { matcher: 'add_strike' },
  );

  return [revealGuard, strikeGuard];
}
