# Garden Doctor

Point your phone's camera at a plant and talk to a doctor about it. Ask
"what's wrong with this one?" and the agent looks through the camera,
diagnoses out loud, and draws on your screen — a labeled box around the
yellowing leaves, a point on the spot to prune.

An example of the SDK's live-camera vision loop, end to end:

1. The page publishes the rear camera with `client.addVideoStream(stream)`.
2. The agent opts into the server vision tools — `detect_objects` and
   `point_at_object` (Moondream-backed locators that return normalized
   coordinates), and `examine_image` for open-ended questions about the
   frame.
3. The locators' results come back to the model, which calls the SDK's
   client-side renderers `cosmo_sdk_draw_box` / `cosmo_sdk_draw_point`.
4. The page maps those normalized coordinates through
   `boxRect`/`pointPosition` (`cosmo-ai/tool/video_geometry`) onto the
   cropped full-screen preview and draws the overlay.

The locators run in the background, so the doctor keeps talking while the
box lands a beat later — the persona is written to expect that.

## Run it

```bash
npm install
cp .env.example .env   # then paste a Cosmo API key into VITE_COSMO_API_KEY
npm run dev
```

The key needs the `realtime:use` scope (Developer platform → API keys in the
Cosmo web app). Open the Vite URL on your laptop and click **Start the
visit** — the browser asks for camera and microphone, then the session is
live.

## Run it on your phone

Phone browsers only allow camera and microphone on HTTPS, so the dev server
needs a tunnel:

```bash
npm run dev
# in another terminal:
cloudflared tunnel --url http://localhost:7880
```

Open the printed `https://….trycloudflare.com` URL on the phone (iOS Safari
and iOS Chrome both work — Chrome on iOS runs on WebKit, so behavior
matches). Tap **Start the visit**: the tap doubles as the user gesture that
unlocks audio playback, and the app holds a screen wake lock so the phone
doesn't dim mid-visit. The rear lens is the default; the ⟲ button flips.

## Deploying it

A deployed page holds no Cosmo credential at all. The workspace key lives
server-side in one Pages Function — `functions/token.ts` — that trades the
deployment's access password for short-lived end-user tokens
(`POST /api/v1/external/auth/token`). The page consumes them through
`TokenSource.endpoint('/token', ...)` and calls the Cosmo API directly:
`/api/v1/external/*` answers wildcard CORS, so no proxy is involved. Use a
key with only the `user_tokens:mint` scope (a provisioning key): it can mint
tokens but never start sessions or dial.

`npm run pages:build` blanks `VITE_COSMO_API_KEY` and
`scripts/assert-no-credential.js` fails the build if anything key-shaped
survived into `dist/`.

```bash
npx wrangler pages project create cosmo-garden-doctor --production-branch main
npx wrangler pages secret put COSMO_API_KEY --project-name cosmo-garden-doctor
npx wrangler pages secret put APP_PASSWORD  --project-name cosmo-garden-doctor
npm run pages:deploy
```

Pointing a deployment at a non-production Cosmo backend takes **two**
settings naming the same origin: `VITE_COSMO_BASE_URL` in `.env` at build
time (where the page starts sessions) and a `COSMO_BASE_URL` variable on the
Pages project (where the Function mints). With neither set, both sides
default to production and agree.

## How the pieces fit

| file | what it owns |
|---|---|
| `src/agent.ts`, `src/persona.ts` | The agent: instructions, greeting, voice, and the five tools |
| `src/camera/use_camera.ts` | Rear-lens `getUserMedia`, publish via `addVideoStream`, flip, teardown |
| `src/draw/draw_tools.ts` | The SDK draw renderers, built at module scope with a swappable surface |
| `src/draw/use_draw_marks.ts` | Mark state: accumulate up to six, expire after 20s, wipe on session end |
| `src/CameraStage.tsx` | Full-bleed `<video>` plus the overlay layer, geometry-corrected |
| `functions/token.ts` | The deployment's minting endpoint; the only place a key lives |

Two details worth stealing for your own camera app:

- The draw tools are declared once at module scope, because the session
  starts above the component that owns the camera view. The mounted view
  registers itself as the surface; until it does, the model is told — in
  words it can say — that there is nothing to draw on.
- The preview crops (`object-fit: cover`), and a front lens is mirrored in
  CSS while the published frame is not. `useVideoPlacement` measures the
  element and `boxRect`/`pointPosition` undo both, so a normalized
  coordinate lands where the model actually pointed.

## Notes

- The vision tools need the backend to have Moondream configured. If it
  doesn't, the session still starts and the app surfaces the rejected tools
  in the status pill instead of letting a blind agent take the blame.
- The session cannot start twice in a row within a short window after an
  unclean exit (HTTP 429) — the app says the line is busy; try again in a
  minute.
