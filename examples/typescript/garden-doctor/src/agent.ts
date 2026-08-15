import type { AgentConfig } from 'cosmo-ai';

import { DRAW_TOOLS } from './draw/draw_tools';
import { INSTRUCTIONS, VOICE } from './persona';

/**
 * The whole agent: persona plus four tools. The Moondream-backed locators
 * (`detect_objects`, `point_at_object`) are zero-config server opt-ins that
 * return coordinates; the two client tools are the SDK's draw renderers,
 * which put those coordinates on screen. No model is named: the server
 * default handles live video, and the model watches the camera stream
 * directly rather than through a per-question image tool.
 */
export function gardenDoctorAgent(): AgentConfig {
  return {
    instructions: INSTRUCTIONS,
    // No greeting: it would start the moment the session connects, before the
    // phone's audio output is playing, so its opening words are lost and the
    // user hears a fragment. The doctor waits to be asked.
    voice: VOICE,
    // Nothing here reads thought summaries, and leaving them on costs tokens
    // ahead of the answer.
    modelOptions: { provider: 'gemini', includeThoughts: false },
    tools: [{ kind: 'detect_objects' }, { kind: 'point_at_object' }, ...DRAW_TOOLS],
  };
}
