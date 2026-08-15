import { preToolUse, type Hook, type PreToolUseResult } from 'cosmo-ai';

import type { CookStore } from '../state/store';

const MIN_TIMER_SECONDS = 5;
const MAX_TIMER_SECONDS = 7200;

/**
 * The house rules, as a plain function of the card's current state.
 *
 * A tool schema cannot see the card, so "step 7 of a 5-step recipe" and "that
 * timer label is taken" can only be caught here. Returning a denial with a
 * reason hands the model something it can recover from in words, instead of
 * letting the call through to a handler that would throw.
 */
export function guardDecision(
  store: CookStore,
  toolName: string,
  args: Readonly<Record<string, unknown>>,
): PreToolUseResult | undefined {
  const state = store.getState();

  if (toolName === 'set_step') {
    const stepCount = state.recipe?.steps.length ?? 0;
    if (stepCount === 0) {
      return { permission: 'deny', reason: 'No recipe on the card yet — call set_recipe first.' };
    }
    const index = args.index;
    if (typeof index === 'number' && (index < 0 || index >= stepCount)) {
      return {
        permission: 'deny',
        reason: `Step ${index} does not exist — this recipe has steps 0 to ${stepCount - 1}.`,
      };
    }
  }

  if (toolName === 'start_timer') {
    const seconds = args.seconds;
    if (
      typeof seconds === 'number' &&
      (seconds < MIN_TIMER_SECONDS || seconds > MAX_TIMER_SECONDS)
    ) {
      return {
        permission: 'deny',
        reason: `Timers run ${MIN_TIMER_SECONDS} seconds to 2 hours; ${seconds} is out of range.`,
      };
    }
    const label = args.label;
    if (typeof label === 'string' && state.timers.some((timer) => timer.label === label)) {
      return {
        permission: 'deny',
        reason: `A timer named "${label}" is already running — pick another label, or cancel it first.`,
      };
    }
  }

  if (toolName === 'cancel_timer') {
    const label = args.label;
    if (typeof label === 'string' && !state.timers.some((timer) => timer.label === label)) {
      const running = state.timers.map((timer) => `"${timer.label}"`).join(', ') || 'none';
      return { permission: 'deny', reason: `No timer named "${label}". Running: ${running}.` };
    }
  }

  return undefined;
}

export function makeGuard(store: CookStore): Hook {
  return preToolUse((ctx) => guardDecision(store, ctx.toolName, ctx.arguments));
}
