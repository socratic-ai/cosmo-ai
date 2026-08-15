# Model Router

Type what you want to do — "help me practice a speech" versus "quick question
about my bill" — and a plain keyword table (`src/route.ts`) picks a provider,
tunes its turn-taking, and starts a session already configured for it. The
badge under the prompt box shows which provider was picked and why, plus a
client-measured time-to-first-word.

Provider selection is exactly two lines once you're on the SDK:

```ts
const result = route(text);                     // pick provider/tuning/voice
await client.agent(result.agentConfig).start();  // start with it
```

Everything else in `src/App.tsx` is UI chrome for making that decision
visible — the routing itself needs nothing more than the two lines above.
Scoped to the 3 providers `ModelOptions` exposes today — `gemini`, `openai`,
`openai_mini`.

The `openai`/`openai_mini` routes need the `realtime-openai-provider-enabled`
feature flag on for your workspace — off (the default in most environments),
a session started against one of those routes is rejected with
`model_unavailable`. The Gemini routes (practice/brainstorm, and the
fallback for anything unmatched) work regardless.

## Run it

```bash
npm install
npm run dev
```

Open the Vite URL, then paste a Cosmo API key with the `realtime:use` scope
(Developer platform → API keys in the Cosmo web app) into the Connection box.
`cp .env.example .env` to skip the pasting on every run.

Try "help me practice a speech" versus "quick question about my bill" —
different provider badges, different turn-taking behavior.

## Deploying it

A deployed page holds no Cosmo credential at all. The workspace key lives
server-side in one Pages Function — `functions/token.ts` — that trades the
deployment's access password for short-lived end-user tokens
(`POST /api/v1/external/auth/token`). The page consumes them through
`TokenSource.endpoint('/token', ...)`, which keeps a fresh one on hand, and
calls the Cosmo API directly: `/api/v1/external/*` answers wildcard CORS, so
no proxy is involved. Each visitor mints under a stable per-browser id, so
usage meters per visitor instead of pooling under one identity.

Use a key with only the `user_tokens:mint` scope (a provisioning key): it can
mint tokens but never start sessions or dial. A shared password is the demo's
stand-in for real auth; an app with per-user accounts should verify its own
users instead — `../token-server` is this same trade as a deployable template
with a pluggable `identifyUser()`.

Vite inlines `VITE_*` into the bundle, so a build made from a dev `.env`
ships a live workspace key to everyone who loads the page. `npm run
pages:build` blanks the variable and `scripts/assert-no-credential.js` fails
the build if anything key-shaped survived; with no key inlined the box in the
UI collects the access password rather than a credential.

```bash
npx wrangler pages project create cosmo-model-router --production-branch main
npx wrangler pages secret put COSMO_API_KEY --project-name cosmo-model-router
npx wrangler pages secret put APP_PASSWORD  --project-name cosmo-model-router
npm run pages:deploy
```

Pointing a deployment at a non-production Cosmo backend takes **two** settings
naming the same origin: `VITE_COSMO_BASE_URL` in `.env` at build time (where
the page starts sessions) and a `COSMO_BASE_URL` variable on the Pages project
(where the Function mints). Set only one and tokens mint against one backend
while sessions start against another — every session fails with a 401. With
neither set, both sides default to production and agree.

## The routing table

`src/route.ts` checks intent against 5 rules, first keyword match wins, and
always falls back to a default when nothing matches:

| Say... | Routes to | Tuning |
|---|---|---|
| "help me practice a speech" | `gemini` | low interrupt sensitivity, 1200ms pause tolerance, human naturalness — patient, won't cut in |
| "quick question about my bill" | `openai_mini` | untuned — cheapest, fastest tier |
| "I'm getting an error, it's not working" | `openai` | semantic VAD, low eagerness — waits for you to finish a thought |
| "this is urgent, asap" | `openai` | server VAD, 400ms silence cutoff — fast turn-taking |
| "let's brainstorm some ideas" | `gemini` | high thinking level, temperature 0.9 — more exploratory |
| anything else | `gemini` | untuned — the fallback stays on the one provider every workspace has |

`#3` and `#4` are the more interesting pair to compare: same provider both
times, but tuned for opposite conversational rhythms.
