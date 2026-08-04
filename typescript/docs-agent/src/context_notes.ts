export const CONTEXT_PREFIX = '[reading]';

/** The note the app sends when the reader moves — silent, so the agent
 *  updates its idea of "here" without interrupting. */
export function scrollNote(label: string, index: number, total: number): string {
  return `${CONTEXT_PREFIX} now on ${label} (section ${index} of ${total}).`;
}

const SELECTION_LIMIT = 1500;

export function selectionNote(selection: string): string {
  const text = selection.length > SELECTION_LIMIT ? `${selection.slice(0, SELECTION_LIMIT)}…` : selection;
  return `${CONTEXT_PREFIX} selected: "${text}"`;
}
