import { useCookState } from '../state/cook';

/** Real recipe steps run long — "mix the flour with a pinch of salt and enough
 *  water to knead into a smooth, pliable dough" is four lines at the size the
 *  short ones want. Dropping a step in size keeps those inside the dock rather
 *  than letting them climb over the pan. */
const LONG_STEP = 90;

/** The one step you are on, in type big enough to read from across the
 *  counter — the only thing on this screen worth looking at with wet hands.
 *  Under it goes whichever is more use right now: what done looks like for
 *  this step, or what the next one is. */
export function StepCard() {
  const { recipe, stepIndex } = useCookState();

  if (recipe === null) {
    return (
      <section className="step step--empty">
        <p>Name a dish and I&rsquo;ll find the recipe.</p>
      </section>
    );
  }

  const step = recipe.steps[stepIndex];
  const next = recipe.steps[stepIndex + 1];
  const long = (step?.text.length ?? 0) > LONG_STEP;

  return (
    <section className="step">
      <p className={`step-text${long ? ' step-text--long' : ''}`}>{step?.text}</p>
      {step?.donenessCue !== undefined ? (
        <p className="step-cue">{`done when: ${step.donenessCue}`}</p>
      ) : (
        next !== undefined && <p className="step-next">{`next: ${next.text}`}</p>
      )}
    </section>
  );
}
