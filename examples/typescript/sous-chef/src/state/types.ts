export type Ingredient = {
  name: string;
  /** Human quantity string as the agent stated it — "200 g", "2 cloves", "a pinch". */
  quantity: string;
  checked: boolean;
};

export type Step = {
  text: string;
  /** Rough duration, when the recipe states one. */
  minutes?: number;
  /** What "done" looks like, folded into examine_image questions — e.g.
   *  "deep golden, edges pulling away from the pan". */
  donenessCue?: string;
};

export type Recipe = {
  title: string;
  servings: number;
  ingredients: Ingredient[];
  steps: Step[];
};

export type Timer = {
  label: string;
  totalSeconds: number;
  remainingSeconds: number;
};

export type CookState = {
  recipe: Recipe | null;
  stepIndex: number;
  timers: Timer[];
  /** Label of the most recently fired timer — the chef's alert face. */
  alert: string | null;
};

export type TimerOutcome = 'fired' | 'cancelled';
