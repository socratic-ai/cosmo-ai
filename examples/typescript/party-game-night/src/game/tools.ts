import { tool } from 'cosmo-ai/tool';
import { zodInput } from 'cosmo-ai/tool/zod';
import { z } from 'zod/v4';

import type { GameStore } from './state';

/**
 * The MC's hands: a component registry behind one `render_ui` mount tool,
 * plus the in-game moves. Every component is prebuilt in the board iframe —
 * these tools carry data (a question, a flip, a score), never markup, which
 * is what keeps every visible move at data-channel latency.
 */
export function makeGameTools(store: GameStore) {
  const renderUi = tool({
    name: 'render_ui',
    description:
      'Put a component on the TV, replacing whatever is showing: a title card (a big show beat — game intro, round break), a feud board (all answers start hidden), a quiz card (opens the buzzers), a charades prompt card (shows the secret word during the look-away, then hides it and runs the timer), or the scoreboard.',
    input: zodInput(
      z.object({
        component: z.enum(['title_card', 'feud_board', 'quiz_card', 'prompt_card', 'scoreboard']),
        title: z
          .string()
          .max(80)
          .optional()
          .describe(
            'title_card: the headline — a beat for the whole room (the night, the game, the round), never one team or player',
          ),
        subtitle: z.string().max(120).optional().describe('title_card: smaller line under it'),
        question: z
          .string()
          .max(200)
          .optional()
          .describe('feud_board: the survey question; quiz_card: the trivia question'),
        label: z
          .string()
          .max(40)
          .optional()
          .describe('quiz_card: which game this question belongs to, shown above it — e.g. "Buzzer Trivia"'),
        word: z.string().max(60).optional().describe('prompt_card: the secret thing to act out'),
        actor: z.string().max(24).optional().describe('prompt_card: who performs it'),
        seconds: z
          .number()
          .int()
          .min(15)
          .max(180)
          .optional()
          .describe('prompt_card: acting time; the board reports when it runs out'),
        // Array counts live in the handler: the restricted tool-schema
        // dialect has no minItems/maxItems.
        answers: z
          .array(
            z.object({
              text: z.string().max(40).describe('Short answer text, as the board shows it'),
              points: z.number().int().min(1).max(100),
            }),
          )
          .optional()
          .describe('feud_board: the 3–8 hidden answers, highest points first'),
      }),
    ),
    handler: async ({ component, title, subtitle, question, label, answers, word, actor, seconds }) => {
      switch (component) {
        case 'title_card': {
          if (!title) throw new Error('title_card needs a title.');
          store.showTitle(title, subtitle ?? null);
          return { rendered: 'title_card' };
        }
        case 'feud_board': {
          if (!question || !answers) {
            throw new Error('feud_board needs both question and answers.');
          }
          if (answers.length < 3 || answers.length > 8) {
            throw new Error(`feud_board takes 3–8 answers, got ${answers.length}.`);
          }
          store.showBoard(question, answers);
          return {
            rendered: 'feud_board',
            answerCount: answers.length,
            note: 'All answers are face-down. Flip them with reveal_answer as people guess.',
          };
        }
        case 'quiz_card': {
          if (!question) throw new Error('quiz_card needs a question.');
          store.showQuiz(question, label ?? null);
          return {
            rendered: 'quiz_card',
            note: 'Buzzers are open — a context note will name whichever team buzzes first.',
          };
        }
        case 'prompt_card': {
          if (!word || !actor) throw new Error('prompt_card needs word and actor.');
          store.showPrompt(word, actor, seconds ?? 60);
          return {
            rendered: 'prompt_card',
            note: 'The word shows during the look-away, then hides while the timer runs. Never say the word aloud.',
          };
        }
        case 'scoreboard': {
          store.showScoreboard();
          return { rendered: 'scoreboard', teams: store.getState().teams };
        }
      }
    },
  });

  const clearBuzzer = tool({
    name: 'clear_buzzer',
    description:
      'Reopen the buzzers on the current quiz question — after a wrong answer, so the other teams can steal.',
    input: zodInput(z.object({})),
    handler: async () => {
      if (!store.clearBuzzer()) throw new Error('No locked buzzer to clear.');
      return { buzzersOpen: true };
    },
  });

  const revealAnswer = tool({
    name: 'reveal_answer',
    description:
      'Flip one hidden answer face-up on the feud board, with the flip animation and its points. `number` is the slot number shown on the board (1 is the top answer).',
    input: zodInput(
      z.object({
        number: z.number().int().min(1).describe('Board slot number, 1-based'),
      }),
    ),
    handler: async ({ number }) => {
      const flipped = store.revealAnswer(number - 1);
      if (flipped === null) throw new Error(`Answer ${number} cannot be flipped.`);
      const board = store.board();
      const hidden = board === null ? 0 : board.answers.filter((a) => !a.revealed).length;
      return { revealed: flipped.text, points: flipped.points, stillHidden: hidden };
    },
  });

  const addStrike = tool({
    name: 'add_strike',
    description:
      'Give the guessing team a strike (a wrong guess) — a big X flashes on the board. Three strikes ends the round.',
    input: zodInput(z.object({})),
    handler: async () => {
      const strikes = store.addStrike();
      if (strikes === null) throw new Error('No strike to give.');
      return { strikes, struckOut: strikes >= 3 };
    },
  });

  const setTeams = tool({
    name: 'set_teams',
    description:
      'Register the teams playing tonight (2–4 team names). Resets all scores to zero, so call it once at the start, not between rounds.',
    input: zodInput(
      z.object({
        teams: z.array(z.string().min(1).max(24)).describe('2–4 team names'),
      }),
    ),
    handler: async ({ teams }) => {
      if (teams.length < 2 || teams.length > 4) {
        throw new Error(`set_teams takes 2–4 teams, got ${teams.length}.`);
      }
      return { teams: store.setTeams(teams) };
    },
  });

  const awardPoints = tool({
    name: 'award_points',
    description:
      'Add points to one team, by the team name registered with set_teams. The teams strip on the TV updates immediately.',
    input: zodInput(
      z.object({
        team: z.string().min(1),
        points: z.number().int().min(1).max(500),
      }),
    ),
    handler: async ({ team, points }) => {
      const updated = store.awardPoints(team, points);
      if (updated === null) {
        const names = store.getState().teams.map((t) => t.name);
        throw new Error(`No team called ${JSON.stringify(team)}; teams are ${JSON.stringify(names)}.`);
      }
      return { team: updated.name, score: updated.score };
    },
  });

  return [renderUi, revealAnswer, addStrike, setTeams, awardPoints, clearBuzzer];
}
