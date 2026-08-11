# ChessReferee

An iOS app that watches a chess game through the camera and referees it out
loud. A 9MB YOLOv9-t ONNX model runs **on-device** (onnxruntime) and reads the
board into FEN a couple of times per second; the app itself checks every move
against the rules; and when someone slips a bishop through a pawn, the Cosmo
voice agent calls it out — unprompted.

This is the general recipe for client-side perception with a realtime agent:

    camera → on-device model → structured state → send(context:) → agent interjects

Swap the chess detector for your own model (or a vision endpoint you host) and
the rest of the app — the state stream, the tools, the interjection — carries
over unchanged.

## What it demonstrates

| SDK surface | Where |
| --- | --- |
| `send(context:)` for silent live app state | `RefereeSessionController.handle(_:)` — every move streams as a `[board]` note; the agent stays quiet |
| Interjection: a tagged `send(text:)` directive | same file — on an illegal move; the app hides the synthetic turn from its own transcript |
| Client tools reading live client state | `get_board_position`, `get_legal_moves` — answered instantly from the on-device game state, no server round-trip |
| Transcript append/replace folding | `RefereeSessionController.apply(...)` |

Why not `send(context:)` alone? Context notes never trigger a spoken response
by design. The Swift SDK has no "trigger a reply" primitive yet, so the
referee moment is a regular text turn tagged `[referee-alert]`, filtered out
of the app's transcript view.

Why is the referee logic in the app and not the agent? Vision noise. The
detector misreads frames; the app requires the same position on 3 consecutive
reads and only accepts transitions a chess rules engine can classify. The
agent gets clean, confident events — and only speaks when there's something
worth saying.

## Run it

```bash
brew install xcodegen          # once
./download-model.sh            # fetches the 9MB detector weights (sha256-pinned)
xcodegen                       # generates ChessReferee.xcodeproj
open ChessReferee.xcodeproj
```

Set your credential: run with the `COSMO_API_KEY` environment variable in the
Xcode scheme, or paste a key into the field on first launch. The key needs the
`realtime:use` scope. For anything beyond a local demo, mint per-user tokens
from your backend instead of embedding a workspace key — see the
[end-user credentials guide](https://platform.askcosmo.ai/docs).

Build and run on a device (the camera loop needs real hardware; the simulator
builds but has no camera).

**Two-minute quickstart, no chess set needed:** open lichess.org or
chess.com on your laptop, prop the phone facing the screen, tap **Calibrate
board** and tap the four board corners, then **Connect**. Play a legal move,
then drag a piece somewhere illegal.

**Physical board:** mount the phone above the board, as close to top-down as
you can, in even light, and calibrate the corners the same way.

## Demo-grade, deliberately

The detector was trained on synthetic 2D board renders (lichess/chess.com
style), not photographs — screen mode is its home turf, and the corner
calibration + perspective correction is what makes a physical board readable
at all. Expect it to need: one board in frame, a near-top-down angle, even
lighting, and a standard piece set. Misreads that survive the stability gate
are classified against the rules engine, so the common failure mode is a
missed event, not a false accusation.

The core pipeline lives in `RefereeKit/` (a local Swift package) and is
tested on macOS — including numerical parity of the detector against the
reference Python implementation it was ported from:

```bash
cd RefereeKit && swift test    # needs the model downloaded first
```

## Layout

```
App/                        SwiftUI app: camera, calibration, session wiring
RefereeKit/
  Sources/RefereeKit/
    ChessDetector.swift     ONNX inference + board→grid geometry
    PieceGrid.swift         grid ↔ FEN placement
    Referee.swift           stability gate, move inference, verdicts
  Tests/                    parity fixture + referee state machine tests
download-model.sh           fetch + verify the weights
project.yml                 xcodegen spec
```
