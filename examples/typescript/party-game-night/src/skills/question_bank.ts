/**
 * Every game is a rules document (``SKILL.md``) plus a bank of content as
 * data (``questions.md`` / ``prompts.md``), assembled into one skill with
 * the bank appended shuffled at session start. The shuffle is the fix for a
 * structural model bias: given a fixed list, the MC favors the top of it —
 * every night opened with the same two questions until the order stopped
 * being the model's to see.
 */

import { parseSkillMd, type Skill } from 'cosmo-ai';

/** How many bank entries each session's skill carries. A hand, not the
 *  deck: plenty for one night, and the next night draws differently. */
export const HAND_SIZE = 25;

/** Rules + a freshly dealt hand from the bank, as the one skill the agent
 *  carries per game. */
export function assembleGameSkill(skillMd: string, bankMd: string, defaultName: string): Skill {
  const skill = parseSkillMd(skillMd, { defaultName });
  return { ...skill, body: `${skill.body}\n\n${shuffledQuestionBank(bankMd, HAND_SIZE)}` };
}

/** ``### ``-delimited question sections, reshuffled — all of them, or a
 *  ``take``-sized hand. */
export function shuffledQuestionBank(text: string, take?: number): string {
  const sections = text
    .split(/^### /m)
    .map((s) => s.trim())
    .filter((s) => s !== '');
  for (let i = sections.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [sections[i], sections[j]] = [sections[j]!, sections[i]!];
  }
  const hand = take === undefined ? sections : sections.slice(0, take);
  return hand.map((s) => `### ${s}`).join('\n\n');
}
