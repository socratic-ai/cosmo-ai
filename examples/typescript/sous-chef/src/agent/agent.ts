import type { AgentConfig, ModelOptions } from 'cosmo-ai';

import type { CookStore } from '../state/store';
import { makeGuard } from './guards';
import { INSTRUCTIONS, SILENCE_PROMPT, VOICE } from './persona';
import { makeClientTools } from './tools';

/** The same agent runs on either provider — everything else in this example
 *  is provider-agnostic, which is rather the point. */
export type CookProvider = 'gemini' | 'openai';

/** `model` selects the provider and `modelOptions` carries that provider's own
 *  knobs — naming one without the other leaves the session on the workspace
 *  default. Each provider's endpointing is tuned the same way: a cook says
 *  short, complete things and then waits, so close the turn promptly rather
 *  than sitting out a long silence window. */
const MODEL_OPTIONS: Record<CookProvider, ModelOptions> = {
  // Thought summaries cost about a second before the first word, and nothing
  // here reads them.
  gemini: { provider: 'gemini', includeThoughts: false, endOfSpeechSensitivity: 'high' },
  openai: { provider: 'openai', turnDetection: 'semantic_vad', eagerness: 'high' },
};

/**
 * The whole agent: a persona, three zero-config server tools, six local tools
 * that write the card, the house-rules guard, and a server-side check-in.
 *
 * `web_search` is how it knows any recipe, and the frame examiner is how it
 * judges doneness — both are opt-ins, with no implementation of ours behind
 * them. `end_call` lets it hang up when the cook is finished.
 *
 * The silence hook runs on the server, so a phone that sleeps or drops its
 * tab still gets the check-in.
 */
export function sousChefAgent(
  store: CookStore,
  provider: CookProvider = 'openai',
): AgentConfig {
  return {
    instructions: INSTRUCTIONS,
    voice: VOICE,
    model: provider,
    modelOptions: MODEL_OPTIONS[provider],
    tools: [
      { kind: 'web_search' },
      { kind: 'examine_image' },
      { kind: 'end_call' },
      ...makeClientTools(store),
    ],
    hooks: [
      makeGuard(store),
      {
        trigger: 'user.speech.timeout',
        timeout_seconds: 120,
        reset_mode: 'on_user_speech',
        max_count: 3,
        action: { type: 'say', prompt: SILENCE_PROMPT },
      },
    ],
  };
}
