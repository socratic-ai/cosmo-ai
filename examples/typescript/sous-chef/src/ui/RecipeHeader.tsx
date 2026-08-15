import { useCookState } from '../state/cook';

/** One line of reference: what you are cooking and how far in. It is not the
 *  thing you look at while cooking — the step is — so it takes a single line
 *  and gives the rest of the screen to the pan. */
export function RecipeHeader() {
  const { recipe, stepIndex } = useCookState();
  if (recipe === null) return null;

  return (
    <div className="recipe-head">
      <h1>{recipe.title}</h1>
      <span className="recipe-meta">
        {`${String(stepIndex + 1)}/${String(recipe.steps.length)}`}
      </span>
    </div>
  );
}
