# Chess referee (endpoint-backed vision)

A web app that watches a chess game through your camera — or a lichess /
chess.com tab via screen share — and referees it out loud. Board reading
happens on a Cosmo backend endpoint, so the browser ships **no vision model**:
it captures a frame, POSTs it, and gets FEN back. The app checks every move
against the rules, and when someone slips a bishop through a pawn, the voice
agent calls it out — unprompted.

This is the thin-client recipe for perception with a realtime agent:

    camera → frame capture → vision endpoint → structured state → sendContext() → agent interjects

It is the same referee design as the [Swift ChessReferee example](../../swift/ChessReferee/)
with the on-device detector swapped for a hosted endpoint — the state stream,
the tools, and the interjection carry over unchanged.

## What it demonstrates

| SDK surface | Where |
| --- | --- |
| `sendContext()` for silent live app state | `App.tsx` `forward()` — every move streams as a `[board]` note; the agent stays quiet |
| Interjection: a tagged `sendText(…, { transcript: false })` directive | same function — on an illegal or out-of-turn move; the directive never appears in the transcript |
| A client tool backed by an HTTP endpoint | `get_chess_board_position` in `tools.ts` — canvas frame capture, one POST, FEN back to the model |
| A pure client tool — compute on the user's machine | `analyze_position` in `analysis/` — Stockfish wasm in a web worker, no backend round-trip |

Why not `sendContext` alone? Context notes never trigger a spoken response by
design. The referee moment is a regular text turn tagged `[referee-alert]`,
sent with `transcript: false` so the user never sees the synthetic directive.

Why is the referee logic in the app and not the agent? Vision noise. The
endpoint misreads frames; the app requires the same position on consecutive
reads and only accepts transitions a chess rules engine (chess.js) can
classify. The agent gets clean, confident events — and only speaks when
there's something worth saying.

## Layout

```
src/
  referee.ts        stability gate, move inference, verdicts (pure; tested)
  referee_loop.ts   capture → endpoint → referee polling loop
  board_vision.ts   client for POST /api/v1/external/chess/board-position
  frame_capture.ts  camera/screen frame → JPEG blob at capture resolution
  tools.ts          get_chess_board_position client tool
  instructions.ts   referee persona + the [referee-alert] contract
  App.tsx           setup form, session view, event → session wiring
  analysis/
    engine.ts             minimal UCI client over a message-port transport
    stockfish_transport.ts  web-worker transport + one lazy engine per app
    position.ts           FEN legality gate + SAN/eval rendering (chess.js)
    analyze_core.ts       validate → search → top moves with eval and line
    analyze_position.ts   the analyze_position client tool
```

## Client-side analysis (`analyze_position`)

Ask the referee what to play and it consults Stockfish — compiled to
WebAssembly, running in a web worker on the user's machine. The contract
mirrors the Cosmo backend's `start_chess_analysis` tool, so instructions
written against either work unchanged: the placement from
`get_chess_board_position` goes in (passed through, never model-authored),
top moves with eval and a short expected line come out.

Two deliberate choices:

- **Single-threaded lite build** (`stockfish-18-lite-single`): the
  multithreaded builds need SharedArrayBuffer and therefore COOP/COEP
  headers on every response, which most dev servers and static hosts don't
  send. Single-threaded lite reaches coaching depth (~12–15) inside its
  750 ms budget and runs anywhere.
- **Served from `public/stockfish/`, not bundled**: the engine `.js` runs
  directly as a worker and fetches its `.wasm` relative to its own URL;
  `scripts/copy_stockfish.mjs` copies both there at install time.

Note: the [`stockfish`](https://www.npmjs.com/package/stockfish) package is
GPL-3.0-licensed. This example depends on it as-is; mind the license if you
reuse this code in your own product.

## Run it

```bash
npm install
cp .env.example .env   # add your key, or paste it into the form at runtime
npm run dev            # http://localhost:7870
```

The key needs the `realtime:use` scope (Developer platform → API keys); the
same key authenticates the board-vision endpoint. For anything beyond a local
demo, mint per-user tokens from your backend instead of embedding a workspace
key — see the [end-user credentials guide](https://platform.askcosmo.ai/docs).

**Two-minute quickstart, no chess set needed:** open lichess.org or chess.com
in another window, pick **Screen share** as the board source, start, and share
that window. Play a legal move, then drag a piece somewhere illegal.

**Physical board:** pick **Camera**, mount the phone or webcam as close to
top-down as you can, in even light. Set **Side nearest the camera** — at the
starting position a board reads legally from both directions, so automatic
orientation can lock the wrong way; telling the app which side is nearest is
the reliable path.

## Demo-grade, deliberately

The endpoint's detector was trained on synthetic 2D board renders
(lichess/chess.com style), so screen share is its home turf; a physical board
needs even light, a near-top-down angle, and a standard piece set. Misreads
that survive the stability gate are classified against the rules engine, so
the common failure mode is a missed event, not a false accusation.

The referee state machine and the analysis stack are pure TypeScript and
tested — including against the real wasm engine:

```bash
npm test
```
