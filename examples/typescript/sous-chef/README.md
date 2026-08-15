# Sous-Chef

Prop your phone against the backsplash and say what you feel like cooking.
Sous-Chef finds the recipe and lays it over the camera feed — a line of
reference along the top, one dock across the bottom with the step you are on
in type you can read from across the counter, and the pan itself filling
everything between. It walks you through a step at a time, runs your timers,
and looks at the pan when it matters. Your hands never touch the screen.

The interesting part is that it speaks up on its own. Ask it to watch the
onions and it arms a short timer, examines the frame when the timer lands,
and either tells you they are ready or quietly arms another one. That
behavior is not a feature of this app — it is two SDK primitives composed by
the persona.

## What it demonstrates

| | |
|---|---|
| `web_search` | How it knows any recipe. There is no recipe database here: the agent searches, then lands the result as one structured `set_recipe` call. Search → structure → typed tool call. |
| `examine_image` | Every doneness judgment. The published camera gives the model occasional stills; anything consequential goes through the tool, which runs a vision model over the freshest frame at full resolution. |
| Background client tools | `start_timer` is `tool({ background: true })`. `job.ack()` releases the reply so the chef keeps talking, and `job.complete()` delivers the outcome minutes later — which is what lets the agent interrupt you. |
| A `PreToolUse` hook | House rules a schema cannot express: a step that does not exist, a timer label already taken, a duration outside 5 seconds to 2 hours. The denial reason goes back to the model, which recovers in words. |
| A `SilenceTimeout` server hook | A quiet kitchen gets a check-in. It runs on the server, so it still fires if the tab sleeps. |
| The OpenAI realtime provider | `model: 'openai'` picks the provider and `modelOptions` carries its knobs — both, or the session quietly runs on the workspace default. |
| Typed session-start errors | The start screen reads `SessionBusyError` / `SessionEntitlementError` / `detail.code` instead of sniffing status codes. |
| `useRealtimeSession()` | The whole session lifecycle: one single-use client per run, the mic released before the next start, every exit path funnelled into one teardown. |

## Run it

```bash
npm install
cp .env.example .env   # then paste a Cosmo API key into VITE_COSMO_API_KEY
npm run dev
```

The key needs the `realtime:use` scope (Developer platform → API keys in the
Cosmo web app). Two things to know before the first run:

- **The workspace must be able to run the OpenAI realtime provider.** If it
  cannot, the session start is rejected with `model_unavailable` and the
  start screen says so. Setting `VITE_REALTIME_PROVIDER=gemini` in `.env`
  runs the same agent, unchanged, on the default provider.
- **The camera is optional.** Deny it and the app says so and carries on:
  recipes, steps, and timers all work, over a plain backdrop instead of the
  pan; only the doneness checks are gone.

## Cook with it on your phone

This is the way to try it. Phone browsers only allow camera and microphone
on HTTPS, so the dev server needs a tunnel — the laptop's LAN address will
not do, because it is plain HTTP:

```bash
npm run dev
# in another terminal, whichever you have:
cloudflared tunnel --url http://localhost:7882
ngrok http 7882
```

Open the printed HTTPS URL on the phone and tap **Start cooking** — the tap
doubles as the gesture that unlocks audio playback. The app holds a screen
wake lock, so the phone will not dim mid-step. Prop it where the rear lens
sees the pan.

Both tunnel hostnames are in `server.allowedHosts` in `vite.config.ts`; a
different tunnel needs its own entry, or Vite answers "Blocked request".
ngrok's free tier also shows a one-time interstitial before the app — tap
**Visit Site** once per URL.

Then say something like *"I want to make a simple tomato pasta for two"*,
and once you are cooking, *"tell me when the sauce has thickened."*

## How the pieces fit

| file | what it owns |
|---|---|
| `src/agent/agent.ts` | The whole agent: server-tool opt-ins, client tools, guard, silence hook, provider |
| `src/agent/persona.ts` | Instructions — the hands-free ethos, the timer rules, the watch protocol |
| `src/agent/tools.ts` | The six tools that write the cook's state, including the background timer |
| `src/agent/guards.ts` | House rules, as a plain function of that state, wrapped in a `PreToolUse` hook |
| `src/state/store.ts` | `CookStore`: recipe, step, ingredients, timers, alert — on an injectable clock |
| `src/camera/use_camera.ts` | Rear-lens `getUserMedia`, publish via `session.addVideoStream`, teardown |
| `src/ui/LiveView.tsx` | The layout: the frame full bleed, everything else in two bands at its edges |
| `src/ui/Avatar.tsx` | The chef's face and its thought bubble, derived entirely from session state |
| `scripts/smoke.ts` | A whole cook driven through the store with no session, plus schema and guard checks |

Four details worth stealing:

- **In a camera app, every pixel of UI is taken from the subject.** There is
  no caption strip here, and the ingredient checklist is one line along the
  bottom rather than a panel down the side — an ordinary recipe has sixteen
  ingredients, and stacked vertically they cover the pan you propped the
  phone up to see. The count at its head is the one tap the screen allows
  itself: it opens the full list as a sheet, for the glance across the shelf
  before starting that a sideways strip cannot give. The strip removes
  itself once everything is ticked. The
  captions went because the chef says all of it out loud: printing the same
  words under the step it just described costs the frame and tells you
  nothing.
- **The tools are the only writers.** Every component reads the store, and
  nothing else writes it, so what is on screen cannot drift from what the
  chef just said. `useSyncExternalStore` does the rest.
- **State-dependent validation belongs in the hook, not the schema.** A Zod
  schema cannot know which timer labels are taken. `guardDecision` is a plain
  function of store state, which is why the smoke check can exercise it
  directly.
- **The avatar is a session-state visualizer.** `idle`/`listening`/
  `thinking`/`speaking` come from `useAgentState()`, `looking` from an
  in-flight `cosmo_examine_image` call in `useToolCalls()`, `alert` from a
  timer that just landed. The thought bubble shows the two of those you
  cannot hear — working something out, and reading the frame. Nothing is
  animated for decoration.

## Notes

- **Array bounds are not expressible in tool schemas, but numeric ones are.**
  The backend's restricted dialect has no `minItems`/`maxItems`, so a Zod
  `.min()` on an *array* throws when the tool is constructed — state that
  bound in the description and enforce it in the handler. It does have
  `minimum`/`maximum`, and `zodInput` validates against them before your
  handler runs, so `.min()` on a *number* is a real gate. `set_recipe` uses
  one: servings is the divisor in every rescale, and a zero there would put
  `Infinity g` on screen. Note that `.positive()` is not the way to write it
  — Zod emits that as `exclusiveMinimum`, which the dialect rejects.
  `npm run smoke` asserts both halves.
- **Nothing in code bounds the watch loop.** "Tell me when the onions are
  golden" arms a timer, looks once, and may arm another — and what stops
  that repeating forever is a sentence in the persona, not a counter. That
  is deliberate here: the point of the example is that the loop is composed
  from two primitives rather than built in. It is also the first thing to
  change if you copy it somewhere that bills per vision call. A cap belongs
  in `guardDecision`, which already sees every `start_timer` and can count
  how many watch timers a step has spent.
- **Reconnecting keeps your recipe, not the chef's memory.** Timers keep
  counting down locally across a dropped session, but a background job
  belongs to the session that started it, so a timer that lands after a
  reconnect cannot announce itself. The new session is handed a
  `sendContext` note describing the recipe, the step, and what is still
  running, and picks up from there. Tapping **Done cooking** is the other
  case: an ending the app asked for clears everything, so the next start is a
  fresh cook.
- **This example authenticates with an API key, which is right for local dev
  and wrong for anything you deploy.** Vite inlines `VITE_*` values into the
  bundle, so a build made with a key in `.env` publishes that key. A
  deployed page should mint short-lived end-user tokens from your own
  backend instead — the `token-server` example is that backend, and
  `TokenSource.endpoint(...)` is the client half.
- The session cannot start twice in a row within a short window after an
  unclean exit (HTTP 429) — the app says the line is busy; try again in a
  minute.
