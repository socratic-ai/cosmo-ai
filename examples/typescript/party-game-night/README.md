# Party Game Night

Say "let's play Family Feud" and a game board materializes on the TV. An AI
host MCs the night by voice — it puts up the board, flips the answers people
shout, hands out strikes, and keeps score. One device, the whole room playing.

Three games ship on the shelf: **Family Feud**, **buzzer trivia** (number
keys are the buzzers), and **charades** (the board keeps the secret word and
the clock). Each game is a skill; the host offers the menu.

An example of **generative UI over client tools**: the agent drives the
screen, but every component is prebuilt. `render_ui` and its sibling tools
carry data — a question, a flip, a score — never markup, so every visible
move lands at data-channel latency while the host is still mid-sentence.

This is the **flagship TypeScript example**: the one that puts the whole
surface — client tools, skills, hooks, a sandboxed render target, a server
tool — into a single working app, and the largest one here by design. The
three content decks are content, not machinery; they change without touching
the code. For something smaller, read
[`realtime-page`](../realtime-page) for the minimum viable session or
[`garden-doctor`](../garden-doctor) for one feature done end to end.

## What it demonstrates

- **A component registry behind client tools** — `render_ui` mounts one of
  five prebuilt components (title card, feud board, quiz card, charades
  prompt card, scoreboard); the in-game moves (`reveal_answer`,
  `add_strike`, `set_teams`, `award_points`, `clear_buzzer`) are typed with
  Zod via `tool()` + `zodInput`, so a malformed call fails before it touches
  the board.
- **A sandboxed render surface** — the board is an iframe with
  `sandbox="allow-scripts"` and no same-origin, fed full render state over
  `postMessage`. Code never crosses that boundary, only data, and all text
  lands via `textContent`. The sandbox drops same-origin access but not the
  network, so the board document carries a `default-src 'none'` CSP to stay
  offline.
- **Live state flows both ways** — buzzer presses and the charades timer
  reach the host as silent `sendContext` notes: the MC knows who buzzed
  first and when time ran out without anyone saying it aloud, and the room
  only ever hears the host react.
- **Skills as the game shelf** — each game is a rules `SKILL.md` plus a
  content bank as data, assembled with `parseSkillMd` and attached via
  `skills` with the bank shuffled fresh each session. The resident menu *is*
  the game list; a body loads mid-call when the room picks that game. Adding
  a game is markdown, not code.
- **A server tool for judgment calls** — `web_search` backs the trivia
  host's dispute rulings.
- **Hooks as house rules** — `preToolUse` guards make the host physically
  unable to flip an answer twice, flip past the board, or strike a finished
  round; a denial's reason goes back to the model, which recovers in
  character.
- **A server hook as the safety net** — a `SilenceTimeout` nudge fires
  server-side when the room goes quiet, even if the tab dies.
- **`end_call`** — the host wraps the night itself, and the goodbye finishes
  before the line drops.

## Run it

```bash
npm install
cp .env.example .env   # then paste a Cosmo API key into VITE_COSMO_API_KEY
npm run dev
```

The key needs the `realtime:use` scope (Developer platform → API keys in the
Cosmo web app). Open the Vite URL — ideally in a browser on the TV — click
**Start game night**, allow the microphone, and tell the host who's playing.

**Your API key and the server have to come from the same environment.** A key
minted against one backend won't authenticate against another — you get a
401 and the session never connects. If you point `VITE_COSMO_BASE_URL` at a
non-production backend, use a key from that backend.

## One room, one microphone

This is deliberately a single-device app: one browser, one mic, one TV. No
provider offers true full duplex today, and a far-field mic in a loud room is
the hardest audio case there is — so the host is written to hold the floor,
take answers one at a time, and re-ask rather than guess. If the host talks
over itself, that's usually the TV's speakers feeding the mic: turn the
volume down a notch or host from a laptop with headphones as the "control
booth".

## How the pieces fit

| file | what it owns |
|---|---|
| `src/persona.ts`, `src/agent.ts` | The MC: instructions, greeting, voice, tools, skills, hooks |
| `src/skills/*/SKILL.md` | Each game's hosting flow and judging rules (family_feud, buzzer_trivia, charades) |
| `src/skills/*/questions.md`, `prompts.md` | Each game's content bank — data, appended to its skill shuffled at session start so no night opens the same way |
| `src/game/state.ts` | Canonical game state — tools mutate it, the board renders it, the guard reads it |
| `src/game/tools.ts` | The registry: `render_ui` plus the in-game moves, Zod-typed |
| `src/game/guard.ts` | House rules as `preToolUse` hooks |
| `src/board/board_document.ts` | The TV: a self-contained srcdoc document with every component |
| `src/board/BoardFrame.tsx` | The sandboxed iframe and the `postMessage` bridge |
| `src/App.tsx`, `src/LiveView.tsx` | Session lifecycle and the show chrome |
| `public/stage-bg.jpg` | AI-generated stage backdrop, shared by the page and the board (the board falls back to a gradient without it) |

## Where this goes next

The board contract is game-agnostic — a new game is a `SKILL.md` plus a
content bank, and only sometimes a new component. Still on the roadmap from
the original design: pointing a live camera at the charades actor so the
host can watch too (`addVideoStream` + `examine_image`), and an encore where
a background client tool has a bigger model fill a fresh round template
while the host keeps talking.
