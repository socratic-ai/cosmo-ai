import type { CookState, Recipe, Timer, TimerOutcome } from './types';

const EMPTY: CookState = { recipe: null, stepIndex: 0, timers: [], alert: null };

/** Scale "200 g" → "300 g" when the cook goes from 2 servings to 3. Handles a
 *  leading integer, decimal, or simple fraction ("1/2 cup"); anything else
 *  ("a pinch", "to taste") passes through unchanged. */
export function scaleQuantity(quantity: string, factor: number): string {
  const match = /^(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+(?:\.\d+)?))?(.*)$/.exec(quantity.trim());
  if (match === null) return quantity;
  const numerator = Number(match[1]);
  const denominator = match[2] === undefined ? 1 : Number(match[2]);
  if (denominator === 0) return quantity;
  const scaled = (numerator / denominator) * factor;
  return `${Math.round(scaled * 100) / 100}${match[3]}`;
}

/**
 * The one place cooking state lives. Client tools are its only writers and
 * React components are pure readers, so what the card shows is exactly what
 * the agent believes — there is no second copy to drift.
 *
 * The clock is external: the app ticks it on an interval while the session is
 * live, and the smoke script ticks it directly, so timer behavior is testable
 * without waiting in real time.
 */
export class CookStore {
  private state: CookState = EMPTY;
  private listeners = new Set<() => void>();
  private settles = new Map<string, (outcome: TimerOutcome) => void>();

  getState = (): CookState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private commit(next: CookState): void {
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  /** A new recipe is a new cook, so nothing carries over: a timer armed for the
   *  last one would fire for food no longer on the card. Each settles as
   *  cancelled, which is what releases its background job.
   *
   *  Servings is the divisor in every rescale, so a card only ever holds a
   *  count you can divide by; the tool schema bounds it before it reaches
   *  here, and a throw means the two disagree. */
  setRecipe(recipe: Recipe): void {
    if (recipe.servings < 1) {
      throw new RangeError(`servings ${recipe.servings} is not a count`);
    }
    const orphaned = [...this.settles.values()];
    this.settles.clear();
    this.commit({ recipe, stepIndex: 0, timers: [], alert: null });
    for (const settle of orphaned) settle('cancelled');
  }

  /** Throws on an index the recipe does not have. The PreToolUse guard denies
   *  that call before it reaches here, so a throw means the two disagree. */
  setStep(index: number): void {
    const recipe = this.state.recipe;
    if (recipe === null || index < 0 || index >= recipe.steps.length) {
      throw new RangeError(`step ${index} out of range`);
    }
    this.commit({ ...this.state, stepIndex: index });
  }

  /** Case-insensitive substring match; false when nothing on the card matches. */
  checkIngredient(name: string): boolean {
    const recipe = this.state.recipe;
    if (recipe === null) return false;
    const needle = name.trim().toLowerCase();
    let found = false;
    const ingredients = recipe.ingredients.map((item) => {
      if (item.name.toLowerCase().includes(needle)) {
        found = true;
        return { ...item, checked: true };
      }
      return item;
    });
    if (found) this.commit({ ...this.state, recipe: { ...recipe, ingredients } });
    return found;
  }

  scaleServings(servings: number): boolean {
    const recipe = this.state.recipe;
    if (recipe === null || servings < 1) return false;
    const factor = servings / recipe.servings;
    const ingredients = recipe.ingredients.map((item) => ({
      ...item,
      quantity: scaleQuantity(item.quantity, factor),
    }));
    this.commit({ ...this.state, recipe: { ...recipe, servings, ingredients } });
    return true;
  }

  /** Returns a rejection message, or null when the timer is running. The
   *  ``settle`` callback fires exactly once, on expiry or cancellation. */
  startTimer(
    label: string,
    seconds: number,
    settle: (outcome: TimerOutcome) => void,
  ): string | null {
    if (this.state.timers.some((timer) => timer.label === label)) {
      return `a timer named "${label}" is already running`;
    }
    const timer: Timer = { label, totalSeconds: seconds, remainingSeconds: seconds };
    this.settles.set(label, settle);
    this.commit({ ...this.state, timers: [...this.state.timers, timer] });
    return null;
  }

  cancelTimer(label: string): boolean {
    if (!this.state.timers.some((timer) => timer.label === label)) return false;
    const settle = this.settles.get(label);
    this.settles.delete(label);
    this.commit({
      ...this.state,
      timers: this.state.timers.filter((timer) => timer.label !== label),
    });
    settle?.('cancelled');
    return true;
  }

  /** Advance every timer. One that reaches zero leaves the list, becomes the
   *  alert, and settles — which is what tells the agent to speak up. */
  tick(dtSeconds: number): void {
    if (this.state.timers.length === 0) return;
    const still: Timer[] = [];
    const fired: string[] = [];
    for (const timer of this.state.timers) {
      const remaining = timer.remainingSeconds - dtSeconds;
      if (remaining <= 0) fired.push(timer.label);
      else still.push({ ...timer, remainingSeconds: remaining });
    }
    this.commit({
      ...this.state,
      timers: still,
      alert: fired.length > 0 ? fired[fired.length - 1] : this.state.alert,
    });
    for (const label of fired) {
      const settle = this.settles.get(label);
      this.settles.delete(label);
      settle?.('fired');
    }
  }

  clearAlert(): void {
    if (this.state.alert === null) return;
    this.commit({ ...this.state, alert: null });
  }

  /** Clear the card for the next cook. Any pending timer belonged to the
   *  session that just ended, so its settle callback has nowhere to deliver
   *  and is dropped rather than run. */
  reset(): void {
    this.settles.clear();
    this.commit(EMPTY);
  }
}
