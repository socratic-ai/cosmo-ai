import type { AgentConfig } from 'cosmo-ai';

import buzzerTriviaSkill from './skills/buzzer_trivia/SKILL.md?raw';
import buzzerTriviaQuestions from './skills/buzzer_trivia/questions.md?raw';
import charadesSkill from './skills/charades/SKILL.md?raw';
import charadesPrompts from './skills/charades/prompts.md?raw';
import familyFeudSkill from './skills/family_feud/SKILL.md?raw';
import familyFeudQuestions from './skills/family_feud/questions.md?raw';

import { makeHouseRules } from './game/guard';
import type { GameStore } from './game/state';
import { makeGameTools } from './game/tools';
import { assembleGameSkill } from './skills/question_bank';
import { GREETING, INSTRUCTIONS, VOICE } from './persona';

/**
 * The MC: persona, the game tools over the shared store, one skill per game
 * (Family Feud, buzzer trivia, charades — the resident menu is the game
 * list, a body loads when the room picks that game), the house-rules guard,
 * and a server-side silence nudge that fires even if this tab dies.
 * `end_call` lets the MC close the show itself.
 */
export function partyGameNightAgent(store: GameStore): AgentConfig {
  return {
    instructions: INSTRUCTIONS,
    greeting: GREETING,
    voice: VOICE,
    // Nothing here reads thought summaries, and leaving them on costs
    // tokens ahead of every reply — latency the room hears.
    modelOptions: { provider: 'gemini', includeThoughts: false },
    // web_search backs trivia dispute rulings; the game tools are the board.
    tools: [...makeGameTools(store), { kind: 'web_search' }, { kind: 'end_call' }],
    skills: [
      assembleGameSkill(familyFeudSkill, familyFeudQuestions, 'family-feud'),
      assembleGameSkill(buzzerTriviaSkill, buzzerTriviaQuestions, 'buzzer-trivia'),
      assembleGameSkill(charadesSkill, charadesPrompts, 'charades'),
    ],
    hooks: [
      ...makeHouseRules(store),
      {
        trigger: 'user.speech.timeout',
        timeout_seconds: 45,
        reset_mode: 'on_user_speech',
        max_count: 2,
        action: {
          type: 'say',
          prompt:
            'The room has gone quiet for a while. As the MC, tease them back into the game in one playful sentence.',
        },
      },
    ],
  };
}
