# Chess coach (endpoint-backed vision)

A voice chess coach in the browser. Share the tab with your game — lichess,
chess.com, anywhere — and talk through it: the coach reads the
position, runs the engine, and guides you toward the best moves Socratically,
naming the move only when you're stuck or ask for it.

Board reading happens on a Cosmo backend endpoint, so the browser ships **no
vision model**: it captures a frame, POSTs it, and gets FEN back. Analysis is
the opposite — Stockfish wasm runs entirely on your machine. Together they are
the thin-client recipe for perception + compute with a realtime agent:

    screen share → frame capture → vision endpoint → FEN → stockfish.wasm → coached, not recited

## What it demonstrates

| SDK surface | Where |
| --- | --- |
| A client tool backed by an HTTP endpoint | `get_chess_board_position` in `tools.ts` — canvas frame capture, one POST, FEN back to the model |
| A pure client tool — compute on the user's machine | `analyze_position` in `analysis/` — Stockfish wasm in a web worker, no backend round-trip |
| Tool results as coaching material, not script | `instructions.ts` — engine moves come back to the model with the direction to reveal them progressively |

Why two tools instead of one? "Where are the pieces" and "what should be
played" are different questions — the coach often needs the position alone
("is my knight defended?"), and side-to-move is a fact the model knows from
the conversation, not something vision can see.

## Layout

```
src/
  tools.ts             get_chess_board_position client tool
  board_vision.ts      POST /api/v1/external/chess/board-position client
  frame_capture.ts     canvas capture off the screen-share track
  instructions.ts      the Socratic coach persona
  analysis/            analyze_position: stockfish.wasm + FEN plumbing
  App.tsx              lesson setup, connect, session transcript
```

## Run it

```bash
npm install
cp .env.example .env   # add your API key, point at your backend
npm run dev
```

The API key needs the `realtime:use` scope; the same key authenticates the
realtime session and the board-vision endpoint. Against a local backend set
`VITE_COSMO_BASE_URL=https://localhost:8000`.

A 720p JPEG is plenty for the vision endpoint — the detector reads boards
down to ~300px across and re-crops small ones itself, so there is no need to
send full-resolution frames.

```bash
npm run typecheck && npm test && npm run build
```
