/**
 * Writes a throwaway board preview (board.html + preview.html) to the
 * directory given as argv[2], for eyeballing the board states without a
 * session. Not part of the app.
 *
 * Run: npx tsx scripts/preview.ts /tmp/somewhere
 */
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { BOARD_DOCUMENT } from '../src/board/board_document';

const outDir = process.argv[2];
if (!outDir) throw new Error('usage: tsx scripts/preview.ts <out-dir>');
mkdirSync(outDir, { recursive: true });

copyFileSync(new URL('../public/stage-bg.jpg', import.meta.url), join(outDir, 'stage-bg.jpg'));
writeFileSync(join(outDir, 'board.html'), BOARD_DOCUMENT);

const preview = `<!doctype html>
<html><head><meta charset="utf-8"><title>Board preview</title>
<style>
  body { margin: 0; display: grid; grid-template-rows: auto 1fr; height: 100vh; font-family: sans-serif; }
  nav { display: flex; gap: 8px; padding: 8px; background: #222; }
  button { padding: 6px 12px; }
  iframe { width: 100%; height: 100%; border: 0; }
</style></head>
<body>
<nav>
  <button data-state="title">title</button>
  <button data-state="board">board</button>
  <button data-state="reveal">reveal 1+3</button>
  <button data-state="strikes">2 strikes</button>
  <button data-state="quiz">quiz open</button>
  <button data-state="quizBuzzed">quiz buzzed</button>
  <button data-state="prompt">charades</button>
  <button data-state="scoreboard">scoreboard</button>
</nav>
<iframe id="f" sandbox="allow-scripts"></iframe>
<script>
  // Same delivery as the app: srcdoc + postMessage after board-ready.
  const frame = document.getElementById('f');
  let ready = false;
  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'board-ready') ready = true;
  });
  fetch('board.html')
    .then((r) => r.text())
    .then((doc) => {
      const stageBg = new URL('stage-bg.jpg', location.href);
      frame.srcdoc = doc
        .replace('__STAGE_BG__', stageBg.href)
        .replace('__STAGE_BG_ORIGIN__', stageBg.origin);
    });

  const teams = [{ name: 'Sharks', score: 120 }, { name: 'Jets', score: 85 }];
  const answers = (revealed) => [
    { text: 'Phone', points: 34, revealed: revealed.includes(1) },
    { text: 'Keys', points: 26, revealed: revealed.includes(2) },
    { text: 'Wallet', points: 18, revealed: revealed.includes(3) },
    { text: 'Sunglasses', points: 9, revealed: revealed.includes(4) },
    { text: 'Umbrella', points: 7, revealed: revealed.includes(5) },
    { text: 'Lunch', points: 4, revealed: revealed.includes(6) },
  ];
  const states = {
    title: { kind: 'title', title: 'Family Feud', subtitle: 'Round 1 — survey says!' },
    board: { kind: 'board', question: 'Name something people forget when they leave the house.', answers: answers([]), strikes: 0 },
    reveal: { kind: 'board', question: 'Name something people forget when they leave the house.', answers: answers([1, 3]), strikes: 0 },
    strikes: { kind: 'board', question: 'Name something people forget when they leave the house.', answers: answers([1, 3]), strikes: 2 },
    quiz: { kind: 'quiz', question: 'What planet is known as the Red Planet?', label: 'Buzzer Trivia', buzzed: null },
    quizBuzzed: { kind: 'quiz', question: 'What planet is known as the Red Planet?', label: 'Buzzer Trivia', buzzed: 'Sharks' },
    prompt: { kind: 'prompt', word: 'An octopus playing the drums', actor: 'Saira', seconds: 20 },
    scoreboard: { kind: 'scoreboard' },
  };
  document.querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => {
      if (!ready) return;
      frame.contentWindow.postMessage({ type: 'render', stage: states[b.dataset.state], teams }, '*');
    }),
  );
</script>
</body></html>`;

writeFileSync(join(outDir, 'preview.html'), preview);
console.log('wrote', join(outDir, 'preview.html'));
