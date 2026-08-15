import type { RealtimeTool } from 'cosmo-ai';
import { tool } from 'cosmo-ai/tool';
import { zodInput } from 'cosmo-ai/tool/zod';
import * as z from 'zod/v4';

import type { CookStore } from '../state/store';
import type { Recipe } from '../state/types';

// Unlike array bounds, numeric ones survive the restricted dialect as
// `minimum`/`maximum`, and `zodInput` enforces them before the handler runs —
// so this is a real floor, not a hint. It has to be: servings is the divisor
// in every rescale, and zero would put "Infinity g" on the card.
const SERVINGS = { min: 1, max: 100 } as const;

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes === 0) return `${rest} seconds`;
  if (rest === 0) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  return `${minutes} minute${minutes === 1 ? '' : 's'} ${rest} seconds`;
}

/**
 * Every tool the chef uses to keep the card honest, closed over the one store.
 *
 * Bounds that depend on what is already on the card — which steps exist, which
 * timer labels are taken — are not expressible in a schema, so they live in
 * `guards.ts` and come back to the model as a reason it can act on. The
 * descriptions here state them in words for the same reason.
 */
export function makeClientTools(store: CookStore): RealtimeTool[] {
  const setRecipe = tool({
    name: 'set_recipe',
    description:
      'Put a recipe on the card. Call this once the recipe is settled — from ' +
      'web search results or your own knowledge — BEFORE walking the user ' +
      'through any step. Quantities are for the stated servings. Give every ' +
      'cooked step a doneness_cue describing what done looks like.',
    input: zodInput(
      z.object({
        title: z.string(),
        servings: z
          .number()
          .int()
          .min(SERVINGS.min)
          .max(SERVINGS.max)
          .describe('How many people this feeds.'),
        ingredients: z.array(
          z.object({
            name: z.string(),
            quantity: z.string().describe('"200 g", "2 cloves", "a pinch"'),
          }),
        ),
        steps: z.array(
          z.object({
            text: z.string().describe('One imperative sentence.'),
            minutes: z.number().optional().describe('Rough duration, if the recipe states one.'),
            doneness_cue: z
              .string()
              .optional()
              .describe('What done looks like — this is what gets checked against the camera.'),
          }),
        ),
      }),
    ),
    handler: async ({ title, servings, ingredients, steps }) => {
      const recipe: Recipe = {
        title,
        servings,
        ingredients: ingredients.map((item) => ({ ...item, checked: false })),
        steps: steps.map((step) => ({
          text: step.text,
          minutes: step.minutes,
          donenessCue: step.doneness_cue,
        })),
      };
      store.setRecipe(recipe);
      return { ok: true, steps: recipe.steps.length };
    },
  });

  const setStep = tool({
    name: 'set_step',
    description:
      'Move the card to a step (0-based). Call it whenever the user starts, ' +
      'finishes, or asks to jump to a step, so a glance at the phone always ' +
      'shows what they are actually doing.',
    input: zodInput(z.object({ index: z.number().int() })),
    handler: async ({ index }) => {
      store.setStep(index);
      // Moving on is the moment a timer for the step just left becomes
      // stale, and the agent has no other way to notice it is still
      // counting — so hand back what is running and let it decide.
      const running = store.getState().timers.map((timer) => timer.label);
      return { ok: true, index, running_timers: running };
    },
  });

  const checkIngredient = tool({
    name: 'check_ingredient',
    description:
      'Tick an ingredient off the checklist when the user confirms they have ' +
      'it or have prepped it. Matches by name, case-insensitive.',
    input: zodInput(z.object({ name: z.string() })),
    handler: async ({ name }) => {
      const found = store.checkIngredient(name);
      return found
        ? { ok: true }
        : { ok: false, error: `no ingredient matching "${name}" on the card` };
    },
  });

  const scaleServings = tool({
    name: 'scale_servings',
    description:
      'Rescale the card to a new serving count. Numeric quantities are ' +
      'recalculated on the card; say the important changed amounts aloud. ' +
      'Non-numeric quantities ("a pinch") stay as written.',
    input: zodInput(
      z.object({ servings: z.number().int().min(SERVINGS.min).max(SERVINGS.max) }),
    ),
    handler: async ({ servings }) => {
      const ok = store.scaleServings(servings);
      return ok ? { ok: true, servings } : { ok: false, error: 'no recipe on the card yet' };
    },
  });

  // Background: the reply is released by `job.ack()` the moment the countdown
  // is running, so the chef keeps talking, and the real outcome is delivered
  // by `job.complete()` whenever the timer lands — which is what lets the
  // agent interrupt the cook unprompted.
  const startTimer = tool({
    name: 'start_timer',
    description:
      'Start a named countdown between 5 seconds and 2 hours. You are told ' +
      'when it finishes — announce it and say what to do next. Also use short ' +
      'timers to look at the camera later ("check the onions in 2 minutes").',
    input: zodInput(
      z.object({
        label: z.string().describe('Short unique name — "pasta", "check onions".'),
        seconds: z.number().int(),
      }),
    ),
    background: true,
    handler: async ({ label, seconds }, job) => {
      const rejection = store.startTimer(label, seconds, (outcome) => {
        // The countdown outlives the connection, so this can land on a session
        // that is already gone — the card keeps the time, nobody hears it.
        void job
          .complete({
            result: { label, outcome },
            summary:
              outcome === 'fired'
                ? `Timer "${label}" just finished. Tell the user now — and if it was a ` +
                  'watch check, look at the camera before you speak.'
                : `Timer "${label}" was cancelled.`,
          })
          .catch((err: unknown) => {
            console.error(`[sous-chef] timer "${label}" could not be delivered`, err);
          });
      });
      if (rejection !== null) {
        await job.fail({ error: rejection });
        return;
      }
      job.ack(`Timer "${label}" running: ${formatDuration(seconds)}.`);
    },
  });

  const cancelTimer = tool({
    name: 'cancel_timer',
    description: 'Stop a running timer by its label when the user asks.',
    input: zodInput(z.object({ label: z.string() })),
    handler: async ({ label }) => {
      const ok = store.cancelTimer(label);
      return ok ? { ok: true } : { ok: false, error: `no running timer named "${label}"` };
    },
  });

  return [setRecipe, setStep, checkIngredient, scaleServings, startTimer, cancelTimer];
}
