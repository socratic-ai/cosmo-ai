import { useSyncExternalStore } from 'react';

import { CookStore } from './store';
import type { CookState } from './types';

/** One cook at a time, so one store for the whole page: the agent's tools are
 *  its only writers, every component below is a reader. */
export const cookStore = new CookStore();

export function useCookState(): CookState {
  return useSyncExternalStore(cookStore.subscribe, cookStore.getState);
}
