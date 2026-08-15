import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useCookState } from '../state/cook';

/** The checklist as one line along the foot of the dock, ticked off by tool
 *  call. Stacked vertically it covers the pan — sixteen ingredients is an
 *  ordinary shopping list and an enormous panel — so it lies flat instead and
 *  scrolls itself to whatever is still missing. Once nothing is, it goes away
 *  and the pan gets the room back.
 *
 *  The count at its head is the one tap this screen allows itself: it opens
 *  the full list as a sheet, for the glance at everything at once that a
 *  sideways strip cannot give — checking the shelf before starting, not
 *  mid-step with wet hands. */
export function IngredientStrip() {
  const { recipe } = useCookState();
  const [open, setOpen] = useState(false);
  const nextRef = useRef<HTMLLIElement | null>(null);
  const missing = recipe?.ingredients.findIndex((item) => !item.checked) ?? -1;

  useEffect(() => {
    nextRef.current?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [missing]);

  if (recipe === null || missing === -1) return null;

  const done = recipe.ingredients.filter((item) => item.checked).length;
  const total = recipe.ingredients.length;

  return (
    <>
      <div className="ingredient-row">
        <button
          type="button"
          className="ingredient-count"
          onClick={() => {
            setOpen(true);
          }}
          aria-haspopup="dialog"
          aria-label={`Show all ingredients, ${String(done)} of ${String(total)} ready`}
        >
          {`${String(done)}/${String(total)}`}
        </button>
        <ul className="ingredient-strip">
          {/* Index keys: the list is fixed for a recipe and never reordered,
              and two lines can legitimately name the same thing. */}
          {recipe.ingredients.map((item, index) => (
            <li
              key={index}
              ref={index === missing ? nextRef : undefined}
              className={item.checked ? 'checked' : undefined}
            >
              <span className="quantity">{item.quantity}</span> {item.name}
            </li>
          ))}
        </ul>
      </div>
      {/* Portaled: the dock's backdrop-filter makes it the containing block
          for absolute descendants, which would trap the sheet inside it. */}
      {open &&
        createPortal(
        <div
          className="sheet-backdrop"
          onClick={() => {
            setOpen(false);
          }}
        >
          <section
            className="panel sheet"
            role="dialog"
            aria-label="All ingredients"
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            <header className="sheet-head">
              <h2>
                Ingredients
                <span className="sheet-count">{`${String(done)}/${String(total)}`}</span>
              </h2>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setOpen(false);
                }}
              >
                Close
              </button>
            </header>
            <ul className="sheet-list">
              {recipe.ingredients.map((item, index) => (
                <li key={index} className={item.checked ? 'checked' : undefined}>
                  <span className="quantity">{item.quantity}</span> {item.name}
                </li>
              ))}
            </ul>
          </section>
        </div>,
        document.body,
        )}
    </>
  );
}
