/**
 * Build-time smoke test (no session, no network): the skill parses, every
 * tool constructs its model-facing schema, the guard denies what it should,
 * and the board document's inline script at least parses as JS.
 *
 * Run: npx tsx scripts/smoke.ts
 */
import { readFileSync } from 'node:fs';

import { parseSkillMd } from 'cosmo-ai';

import { BOARD_DOCUMENT } from '../src/board/board_document';
import { makeHouseRules } from '../src/game/guard';
import { GameStore } from '../src/game/state';
import { makeGameTools } from '../src/game/tools';
import { HAND_SIZE, assembleGameSkill, shuffledQuestionBank } from '../src/skills/question_bank';

const skillText = readFileSync(new URL('../src/skills/family_feud/SKILL.md', import.meta.url), 'utf8');
const skill = parseSkillMd(skillText, { defaultName: 'family-feud' });
if (skill.name !== 'family-feud' || skill.body.length < 500) {
  throw new Error(`skill parsed oddly: ${skill.name}, body ${skill.body.length} chars`);
}

for (const [game, file] of [
  ['family_feud', 'questions.md'],
  ['buzzer_trivia', 'questions.md'],
  ['charades', 'prompts.md'],
] as const) {
  const bankText = readFileSync(
    new URL(`../src/skills/${game}/${file}`, import.meta.url),
    'utf8',
  );
  const bank = shuffledQuestionBank(bankText);
  const count = (bank.match(/^### /gm) ?? []).length;
  if (count !== 40) throw new Error(`${game}: expected 40 bank entries, got ${count}`);

  const gameSkillText = readFileSync(
    new URL(`../src/skills/${game}/SKILL.md`, import.meta.url),
    'utf8',
  );
  const assembled = assembleGameSkill(gameSkillText, bankText, game);
  const dealt = (assembled.body.match(/^### /gm) ?? []).length;
  if (dealt !== HAND_SIZE) {
    throw new Error(`${game}: expected a ${HAND_SIZE}-entry hand, got ${dealt}`);
  }
}

const store = new GameStore();
const tools = makeGameTools(store);
const names = tools.map((t) => t.name).sort();
console.log('tools:', names.join(', '));

const hooks = makeHouseRules(store);
if (hooks.length !== 2) throw new Error('expected 2 house-rule hooks');

// Drive one round through the store the way the tools would.
store.setTeams(['Sharks', 'Jets']);
store.showBoard('Test question', [
  { text: 'Phone', points: 34 },
  { text: 'Keys', points: 26 },
  { text: 'Wallet', points: 18 },
]);
if (store.setBuzzed('Sharks') !== null) throw new Error('buzz on the feud board not refused');
if (store.revealAnswer(0)?.text !== 'Phone') throw new Error('reveal failed');
if (store.revealAnswer(0) !== null) throw new Error('double reveal not refused');
if (store.addStrike() !== 1 || store.addStrike() !== 2 || store.addStrike() !== 3) {
  throw new Error('strike counting failed');
}
if (store.addStrike() !== null) throw new Error('fourth strike not refused');
if (store.awardPoints('sharks', 34)?.score !== 34) throw new Error('award failed');
if (store.awardPoints('nobody', 1) !== null) throw new Error('unknown team not refused');

store.showQuiz('Test question?', 'Buzzer Trivia');
const quiz = store.getState().stage;
if (quiz?.kind !== 'quiz' || quiz.label !== 'Buzzer Trivia') throw new Error('quiz label not stored');
if (store.setBuzzed('Sharks') !== 'Sharks') throw new Error('buzz failed');
if (store.setBuzzed('Jets') !== null) throw new Error('second buzz not refused');
if (!store.clearBuzzer()) throw new Error('clear buzzer failed');
if (store.setBuzzed('Jets') !== 'Jets') throw new Error('steal buzz failed');
store.showPrompt('A penguin', 'Saira', 60);
if (store.setBuzzed('Sharks') !== null) throw new Error('buzz outside quiz not refused');

// The board runtime: extract the inline script and check it parses.
const match = BOARD_DOCUMENT.match(/<script>([\s\S]*)<\/script>/);
if (!match) throw new Error('board document has no inline script');
new Function(match[1]);

console.log('smoke: ok');
