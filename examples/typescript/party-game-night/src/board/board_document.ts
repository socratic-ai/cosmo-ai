/**
 * The board runtime: a self-contained HTML document rendered into a
 * sandboxed iframe via `srcdoc`. It holds every prebuilt component (title
 * card, feud board, scoreboard) and receives full render state over
 * `postMessage` — no code ever crosses that boundary, only data. All DOM
 * text lands via `textContent`, so model-authored strings can't inject
 * markup even inside the sandbox. The CSP below denies the network outright
 * (the iframe sandbox alone would not), bar the one backdrop image.
 *
 * Kept dependency-free on purpose: this string is the whole "TV".
 */
export const BOARD_DOCUMENT = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: __STAGE_BG_ORIGIN__" />
<style>
  :root {
    --stage: #0a0c26;
    --stage-2: #1a1e56;
    --tray: rgba(6, 8, 32, 0.55);
    --slot-hi: #3448dd;
    --slot-lo: #1d2b9f;
    --slot-edge: rgba(255, 255, 255, 0.16);
    --gold: #f5c343;
    --gold-deep: #b8891f;
    --cream: #faf6ea;
    --ink: #f4f6ff;
    --ink-dark: #171a45;
    --dim: #9aa0e8;
    --strike: #ff4257;
  }
  * { margin: 0; box-sizing: border-box; }
  html, body { height: 100%; }
  /* The stage-bg placeholder below is swapped for an absolute image URL by
     the host page — a relative one would resolve fine, but the CSP has to
     name a concrete origin either way; the closing gradient is the fallback
     stage when the image is absent. */
  body {
    background:
      linear-gradient(rgba(8, 9, 32, 0.45), rgba(6, 7, 26, 0.7)),
      url("__STAGE_BG__") center / cover no-repeat,
      radial-gradient(120% 130% at 50% 0%, var(--stage-2), var(--stage) 72%);
    color: var(--ink);
    font-family: "Avenir Next", -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    position: relative;
  }
  /* Slow spotlight sweep across the stage floor. */
  body::before {
    content: "";
    position: absolute;
    inset: -30%;
    background: conic-gradient(from 0deg at 50% 120%,
      transparent 0deg, rgba(255, 255, 255, 0.05) 12deg, transparent 24deg,
      transparent 100deg, rgba(245, 195, 67, 0.05) 116deg, transparent 132deg,
      transparent 240deg, rgba(255, 255, 255, 0.04) 254deg, transparent 268deg);
    animation: sweep 36s linear infinite;
    pointer-events: none;
  }
  /* Vignette so the slots pop. */
  body::after {
    content: "";
    position: absolute;
    inset: 0;
    background: radial-gradient(115% 100% at 50% 45%, transparent 55%, rgba(0, 0, 5, 0.5));
    pointer-events: none;
  }
  @keyframes sweep { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) {
    body::before { animation: none; }
    .slot.flip, .strike-flash, .strike-flash span, .title-card { animation: none !important; }
  }

  #stage {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3.2vmin;
    padding: 4vmin;
    min-height: 0;
    position: relative;
    z-index: 1;
  }

  .waiting { display: flex; flex-direction: column; align-items: center; gap: 2vmin; }
  .waiting .mark {
    font-size: 6vmin;
    font-weight: 900;
    letter-spacing: 0.28em;
    text-transform: uppercase;
    background: linear-gradient(180deg, #ffe9a8, var(--gold) 55%, var(--gold-deep));
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    text-align: center;
  }
  .waiting .sub { color: var(--dim); font-size: 2.2vmin; letter-spacing: 0.3em; text-transform: uppercase; }

  /* ── title card ─────────────────────────────────── */

  .title-card {
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3vmin;
    padding: 6vmin 8vmin;
    border: 0.35vmin solid rgba(245, 195, 67, 0.55);
    border-radius: 2.4vmin;
    background: var(--tray);
    box-shadow: 0 0 12vmin rgba(78, 92, 255, 0.25), inset 0 0 6vmin rgba(245, 195, 67, 0.06);
    max-width: 88%;
  }
  /* No filter/animation here: either one breaks background-clip: text. */
  .title-card h1 {
    font-size: 9.5vmin;
    font-weight: 900;
    line-height: 1.05;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    background: linear-gradient(180deg, #fff7dd, var(--gold) 60%, var(--gold-deep));
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }
  .title-card { animation: settle 0.6s ease; }
  @keyframes settle { from { transform: scale(1.04); opacity: 0; } to { transform: scale(1); opacity: 1; } }
  .title-card p {
    font-size: 2.8vmin;
    font-weight: 700;
    letter-spacing: 0.24em;
    text-transform: uppercase;
    color: var(--ink);
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 100vmin;
    padding: 1.1vmin 3vmin;
  }

  /* ── feud board ─────────────────────────────────── */

  .question {
    font-size: 3.4vmin;
    font-weight: 800;
    letter-spacing: 0.03em;
    text-align: center;
    text-wrap: balance;
    max-width: 88%;
    padding: 1.8vmin 4vmin;
    border: 0.3vmin solid var(--gold);
    border-radius: 100vmin;
    background: var(--tray);
    box-shadow: 0 0 5vmin rgba(245, 195, 67, 0.15), inset 0 0 3vmin rgba(0, 0, 0, 0.4);
  }

  .tray {
    background: var(--tray);
    border: 0.25vmin solid rgba(255, 255, 255, 0.12);
    border-radius: 2vmin;
    padding: 2vmin;
    width: min(94%, 170vmin);
    box-shadow: inset 0 0 8vmin rgba(0, 0, 5, 0.5);
  }
  .answers {
    list-style: none;
    display: grid;
    grid-auto-flow: column;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1.5vmin;
  }
  .slot {
    height: 9.5vmin;
    border-radius: 1.2vmin;
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
    overflow: hidden;
    background: linear-gradient(180deg, var(--slot-hi), var(--slot-lo) 78%);
    box-shadow: inset 0 0.4vmin 0 var(--slot-edge), inset 0 -1.4vmin 2vmin rgba(0, 0, 20, 0.45), 0 0.7vmin 1.4vmin rgba(0, 0, 10, 0.45);
  }
  /* Diagonal sheen on hidden slots. */
  .slot:not(.open)::after {
    content: "";
    position: absolute;
    inset: 0;
    background: linear-gradient(115deg, transparent 42%, rgba(255, 255, 255, 0.09) 50%, transparent 58%);
  }
  .slot .num {
    width: 6.2vmin;
    height: 6.2vmin;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 3.2vmin;
    font-weight: 900;
    color: var(--gold);
    background: radial-gradient(circle at 50% 35%, #202a86, #101542 70%);
    box-shadow: inset 0 0 0 0.35vmin rgba(245, 195, 67, 0.75), 0 0.4vmin 1vmin rgba(0, 0, 10, 0.5);
  }
  .slot.open {
    background: linear-gradient(180deg, #ffffff, var(--cream) 70%, #e8e0c8);
    color: var(--ink-dark);
    justify-content: space-between;
    padding: 0 1.2vmin 0 2.6vmin;
    box-shadow: inset 0 0.4vmin 0 rgba(255, 255, 255, 0.9), inset 0 -1.2vmin 2vmin rgba(120, 100, 40, 0.18), 0 0.7vmin 1.4vmin rgba(0, 0, 10, 0.45);
  }
  .slot.open .ans {
    font-size: 3.3vmin;
    font-weight: 900;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .slot.open .pts {
    flex: none;
    min-width: 9vmin;
    text-align: center;
    font-size: 3.4vmin;
    font-weight: 900;
    font-variant-numeric: tabular-nums;
    color: var(--ink-dark);
    background: linear-gradient(180deg, #ffe9a8, var(--gold) 60%, var(--gold-deep));
    border-radius: 0.9vmin;
    padding: 1.2vmin 1.6vmin;
    box-shadow: inset 0 0.3vmin 0 rgba(255, 255, 255, 0.6), inset 0 -0.6vmin 1vmin rgba(120, 80, 0, 0.35);
  }
  .slot.flip { animation: flip 0.6s cubic-bezier(0.2, 0.9, 0.3, 1.15); }
  @keyframes flip { from { transform: rotateX(90deg); } to { transform: rotateX(0deg); } }

  /* Three fixed strike sockets; they fill as strikes land. */
  .strikes { display: flex; gap: 2.2vmin; }
  .strikes span {
    width: 6.4vmin;
    height: 6.4vmin;
    border-radius: 1vmin;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 4vmin;
    font-weight: 900;
    color: rgba(255, 255, 255, 0.14);
    background: rgba(0, 0, 10, 0.4);
    border: 0.25vmin solid rgba(255, 255, 255, 0.12);
  }
  .strikes span.hit {
    color: var(--strike);
    border-color: rgba(255, 66, 87, 0.6);
    text-shadow: 0 0 2.4vmin rgba(255, 66, 87, 0.7);
  }

  .strike-flash {
    position: fixed;
    inset: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 3vmin;
    background: rgba(6, 4, 24, 0.78);
    animation: flashfade 1s ease forwards;
    pointer-events: none;
  }
  .strike-flash span {
    font-size: 26vmin;
    font-weight: 900;
    color: var(--strike);
    text-shadow: 0 0 8vmin rgba(255, 66, 87, 0.8);
    animation: slam 0.3s ease;
  }
  @keyframes flashfade { 0%, 70% { opacity: 1; } 100% { opacity: 0; } }
  @keyframes slam { from { transform: scale(2.4) rotate(-6deg); opacity: 0; } to { transform: scale(1) rotate(0deg); opacity: 1; } }

  /* ── quiz card (buzzer trivia) ──────────────────── */

  .quiz { display: flex; flex-direction: column; align-items: center; gap: 3vmin; width: min(92%, 150vmin); }
  .quiz .game-tag {
    font-size: 2.2vmin;
    font-weight: 900;
    letter-spacing: 0.26em;
    text-transform: uppercase;
    color: var(--ink-dark);
    background: linear-gradient(180deg, #ffe9a8, var(--gold) 60%, var(--gold-deep));
    border-radius: 100vmin;
    padding: 0.9vmin 2.8vmin;
  }
  .quiz .q {
    font-size: 4.4vmin;
    font-weight: 800;
    text-align: center;
    text-wrap: balance;
    padding: 4vmin 5vmin;
    border: 0.35vmin solid var(--gold);
    border-radius: 2vmin;
    background: var(--tray);
    box-shadow: 0 0 6vmin rgba(245, 195, 67, 0.15);
  }
  .quiz .buzz-open {
    font-size: 2.4vmin;
    font-weight: 800;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: var(--dim);
    animation: buzzpulse 1.2s ease-in-out infinite;
  }
  @keyframes buzzpulse { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }
  .quiz .buzz-lock {
    font-size: 3.4vmin;
    font-weight: 900;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink-dark);
    background: linear-gradient(180deg, #ffe9a8, var(--gold) 60%, var(--gold-deep));
    border-radius: 100vmin;
    padding: 1.4vmin 4vmin;
    animation: slam 0.25s ease;
  }

  /* ── prompt card (charades) ─────────────────────── */

  .prompt { display: flex; flex-direction: column; align-items: center; gap: 3vmin; width: min(92%, 150vmin); }
  .prompt .stagecue {
    font-size: 2.6vmin;
    font-weight: 800;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--strike);
  }
  .prompt .word {
    font-size: 8vmin;
    font-weight: 900;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    text-align: center;
    padding: 4vmin 6vmin;
    border: 0.35vmin solid var(--gold);
    border-radius: 2vmin;
    background: var(--tray);
  }
  .prompt .word.hidden-word { color: var(--dim); font-size: 5vmin; border-style: dashed; }
  .prompt .timer {
    width: min(80%, 120vmin);
    height: 2.4vmin;
    border-radius: 100vmin;
    background: rgba(0, 0, 10, 0.5);
    border: 1px solid rgba(255, 255, 255, 0.14);
    overflow: hidden;
  }
  .prompt .timer .fill {
    height: 100%;
    background: linear-gradient(90deg, var(--gold-deep), var(--gold));
    animation-name: drain;
    animation-timing-function: linear;
    animation-fill-mode: forwards;
  }
  @keyframes drain { from { width: 100%; } to { width: 0%; } }

  /* ── scoreboard ─────────────────────────────────── */

  .scoreboard { display: flex; gap: 3vmin; width: min(92%, 150vmin); align-items: stretch; }
  .score-card {
    flex: 1;
    background: linear-gradient(180deg, var(--slot-hi), var(--slot-lo) 80%);
    border-radius: 1.8vmin;
    padding: 4vmin 2vmin 3.4vmin;
    text-align: center;
    display: flex;
    flex-direction: column;
    gap: 1.4vmin;
    box-shadow: inset 0 0.4vmin 0 var(--slot-edge), 0 1vmin 2.4vmin rgba(0, 0, 10, 0.5);
    position: relative;
  }
  .score-card .name {
    font-size: 3vmin;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .score-card .score {
    font-size: 10vmin;
    font-weight: 900;
    line-height: 1;
    font-variant-numeric: tabular-nums;
    background: linear-gradient(180deg, #fff2c8, var(--gold) 65%, var(--gold-deep));
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }
  .score-card.leader {
    outline: 0.45vmin solid var(--gold);
    box-shadow: inset 0 0.4vmin 0 var(--slot-edge), 0 0 6vmin rgba(245, 195, 67, 0.35);
  }
  .score-card.leader::before {
    content: "IN THE LEAD";
    position: absolute;
    top: -1.6vmin;
    left: 50%;
    transform: translateX(-50%);
    font-size: 1.7vmin;
    font-weight: 900;
    letter-spacing: 0.22em;
    color: var(--ink-dark);
    background: linear-gradient(180deg, #ffe9a8, var(--gold));
    border-radius: 100vmin;
    padding: 0.6vmin 2vmin;
    white-space: nowrap;
  }

  /* ── teams strip ────────────────────────────────── */

  .teams-strip {
    position: relative;
    z-index: 1;
    display: flex;
    justify-content: center;
    gap: 2vmin;
    padding: 1.2vmin 2vmin 2.2vmin;
  }
  .teams-strip .chip {
    display: flex;
    align-items: center;
    gap: 1.2vmin;
    font-size: 2.2vmin;
    font-weight: 800;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    background: rgba(6, 8, 32, 0.6);
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 100vmin;
    padding: 0.9vmin 2.2vmin;
  }
  .teams-strip .score { color: var(--gold); font-variant-numeric: tabular-nums; }
</style>
</head>
<body>
<div id="stage"></div>
<div id="teams" class="teams-strip"></div>
<script>
(function () {
  'use strict';
  var stageEl = document.getElementById('stage');
  var teamsEl = document.getElementById('teams');
  // What the last render showed — enough to know which slot just flipped
  // (animate it) and whether a strike was just added (flash it).
  var prev = { kind: null, revealed: [], strikes: 0 };
  var STRIKE_MAX = 3;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function renderWaiting() {
    var wrap = el('div', 'waiting');
    wrap.appendChild(el('div', 'mark', 'Party Game Night'));
    wrap.appendChild(el('div', 'sub', 'The host will take it from here'));
    stageEl.appendChild(wrap);
  }

  function renderTitle(stage) {
    var card = el('div', 'title-card');
    card.appendChild(el('h1', null, stage.title));
    if (stage.subtitle) card.appendChild(el('p', null, stage.subtitle));
    stageEl.appendChild(card);
  }

  function renderBoard(stage) {
    stageEl.appendChild(el('div', 'question', stage.question));

    var tray = el('div', 'tray');
    var list = el('ol', 'answers');
    var rows = Math.ceil(stage.answers.length / 2);
    list.style.gridTemplateRows = 'repeat(' + rows + ', minmax(0, 1fr))';
    var sameBoard = prev.kind === 'board' && prev.revealed.length === stage.answers.length;
    stage.answers.forEach(function (answer, i) {
      var slot;
      if (answer.revealed) {
        var justFlipped = sameBoard && !prev.revealed[i];
        slot = el('li', 'slot open' + (justFlipped ? ' flip' : ''));
        slot.appendChild(el('span', 'ans', answer.text));
        slot.appendChild(el('span', 'pts', String(answer.points)));
      } else {
        slot = el('li', 'slot');
        slot.appendChild(el('span', 'num', String(i + 1)));
      }
      list.appendChild(slot);
    });
    tray.appendChild(list);
    stageEl.appendChild(tray);

    var strikes = el('div', 'strikes');
    for (var s = 0; s < STRIKE_MAX; s++) {
      strikes.appendChild(el('span', s < stage.strikes ? 'hit' : null, '\\u2716'));
    }
    stageEl.appendChild(strikes);

    if (prev.kind === 'board' && stage.strikes > prev.strikes) flashStrikes(stage.strikes);
  }

  function flashStrikes(count) {
    var flash = el('div', 'strike-flash');
    for (var i = 0; i < count; i++) flash.appendChild(el('span', null, '\\u2716'));
    document.body.appendChild(flash);
    setTimeout(function () { flash.remove(); }, 1000);
  }

  function renderQuiz(stage) {
    var wrap = el('div', 'quiz');
    if (stage.label) wrap.appendChild(el('div', 'game-tag', stage.label));
    wrap.appendChild(el('div', 'q', stage.question));
    if (stage.buzzed) {
      wrap.appendChild(el('div', 'buzz-lock', stage.buzzed + ' buzzed!'));
    } else {
      wrap.appendChild(el('div', 'buzz-open', 'Buzzers open — hit your key!'));
    }
    stageEl.appendChild(wrap);
  }

  // The look-away beat, then the word hides and the timer drains; when it
  // empties the parent is told, so the host knows time is up without
  // anyone saying so.
  var REVEAL_MS = 6000;
  var promptTimers = [];
  function clearPromptTimers() {
    promptTimers.forEach(function (t) { clearTimeout(t); });
    promptTimers = [];
  }

  function renderPrompt(stage) {
    var wrap = el('div', 'prompt');
    var cue = el('div', 'stagecue', 'Everyone but ' + stage.actor + ' — eyes away!');
    var word = el('div', 'word', stage.word);
    wrap.appendChild(cue);
    wrap.appendChild(word);
    var timer = el('div', 'timer');
    var fill = el('div', 'fill');
    timer.appendChild(fill);
    stageEl.appendChild(wrap);

    promptTimers.push(setTimeout(function () {
      cue.textContent = stage.actor + ' is acting — shout your guesses!';
      cue.style.color = '';
      word.textContent = 'the word is hidden';
      word.className = 'word hidden-word';
      wrap.appendChild(timer);
      fill.style.animationDuration = stage.seconds + 's';
      promptTimers.push(setTimeout(function () {
        parent.postMessage({ type: 'board-event', event: 'prompt-timer-finished' }, '*');
      }, stage.seconds * 1000));
    }, REVEAL_MS));
  }

  function renderScoreboard(teams) {
    var wrap = el('div', 'scoreboard');
    var top = teams.reduce(function (max, t) { return Math.max(max, t.score); }, 0);
    teams.forEach(function (team) {
      var leads = team.score === top && top > 0;
      var card = el('div', 'score-card' + (leads ? ' leader' : ''));
      card.appendChild(el('div', 'name', team.name));
      card.appendChild(el('div', 'score', String(team.score)));
      wrap.appendChild(card);
    });
    stageEl.appendChild(wrap);
  }

  function renderTeamsStrip(stage, teams) {
    teamsEl.replaceChildren();
    if (stage && stage.kind === 'scoreboard') return;
    teams.forEach(function (team) {
      var chip = el('span', 'chip', team.name);
      chip.appendChild(el('span', 'score', String(team.score)));
      teamsEl.appendChild(chip);
    });
  }

  // A quiz buzz updates the same stage kind; re-running the prompt timers on
  // that kind of re-render would restart charades mid-act, so they only
  // reset when the prompt itself changes.
  var promptKey = null;
  function render(stage, teams) {
    var nextPromptKey =
      stage && stage.kind === 'prompt' ? stage.word + '|' + stage.actor : null;
    if (nextPromptKey !== promptKey) clearPromptTimers();
    var promptChanged = nextPromptKey !== promptKey;
    promptKey = nextPromptKey;
    if (!promptChanged && stage && stage.kind === 'prompt') return;

    stageEl.replaceChildren();
    if (!stage) {
      renderWaiting();
    } else if (stage.kind === 'title') {
      renderTitle(stage);
    } else if (stage.kind === 'board') {
      renderBoard(stage);
    } else if (stage.kind === 'quiz') {
      renderQuiz(stage);
    } else if (stage.kind === 'prompt') {
      renderPrompt(stage);
    } else if (stage.kind === 'scoreboard') {
      renderScoreboard(teams);
    }
    renderTeamsStrip(stage, teams);
    prev = {
      kind: stage ? stage.kind : null,
      revealed: stage && stage.kind === 'board'
        ? stage.answers.map(function (a) { return a.revealed; })
        : [],
      strikes: stage && stage.kind === 'board' ? stage.strikes : 0,
    };
  }

  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || msg.type !== 'render') return;
    render(msg.stage, msg.teams || []);
  });

  render(null, []);
  // A sandboxed frame has an opaque origin, so '*' is the only usable target.
  parent.postMessage({ type: 'board-ready' }, '*');
})();
</script>
</body>
</html>`;
