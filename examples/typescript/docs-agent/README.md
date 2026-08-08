# Docs agent

Open a PDF or a link, read it, and talk to a Cosmo agent that is reading it
with you. Ask "what's this table saying?" about the page you're on, select a
paragraph and ask it to explain, or ask about something twenty pages away —
the agent looks it up rather than guessing.

An example of using the SDK's client tools to give an agent a *live* view of
the app instead of a snapshot: the reader's scroll position and text
selection are read at call time, so scrolling never means restarting the
session.

## Run it

```bash
npm install
```

Two processes: the Vite dev server, and a small backend whose only job is
fetching URLs (a browser can't fetch a cross-origin page).

```bash
npm run server
```

```bash
npm run dev
```

Open the Vite URL, open a PDF or paste a link, then click **Start talking**
and paste a Cosmo API key with the `realtime:use` scope (Developer platform →
API keys in the Cosmo web app). `cp .env.example .env` to skip the pasting on
every run.

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
npx wrangler pages project create cosmo-docs-agent --production-branch main
npx wrangler pages secret put COSMO_API_KEY --project-name cosmo-docs-agent
npx wrangler pages secret put APP_PASSWORD  --project-name cosmo-docs-agent
npm run pages:deploy
```

Pointing a deployment at a non-production Cosmo backend takes **two** settings
naming the same origin: `VITE_COSMO_BASE_URL` in `.env` at build time (where
the page starts sessions) and a `COSMO_BASE_URL` variable on the Pages project
(where the Function mints). Set only one and tokens mint against one backend
while sessions start against another — every session fails with a 401. With
neither set, both sides default to production and agree.

Workers have no DNS resolver, so the deployed URL fetcher screens the literal
host and otherwise relies on the platform refusing to route `fetch` into
private address space; the Express dev server resolves and screens every
answer. Both share `shared/page.js`.

## How the agent sees the document

Both sources reduce to one model — a title plus ordered `sections` of text
(`src/document.ts`). A PDF section is a page, extracted client-side with
`pdfjs-dist`; the file itself never leaves the browser. A web page section is
a heading block, extracted and sanitized server-side.

A document short enough to fit rides in the prompt whole; anything longer and
the prompt (`src/agent/instructions.ts`) carries only the outline — labels and
counts — so a 400-page PDF costs the same at session start as a one-pager.
Body text arrives through five client tools (`src/agent/tools.ts`):

| tool | what it answers |
|---|---|
| `get_current_view` | "what am I looking at?" — the section on screen, plus any selection |
| `read_document` | the whole thing, for "what is this?" and anything else document-wide |
| `get_section` | one section in full, by index |
| `search_document` | where a phrase appears, as snippets with section indices |
| `get_outline` | the section list, no body text |

On top of that the app pushes `[reading] …` notes (`client.sendContext(...)`)
when you scroll to a new section or select text, so the agent's idea of "here"
stays current. `sendContext` is the primitive for exactly this: the note lands
in the model's context without becoming a turn, so the agent never speaks up
about it and nothing reaches the transcript panel.

## Rendering a fetched page

`POST /local/fetch-url` resolves the host and refuses private, loopback and
link-local addresses (following redirects manually, so a public host can't
bounce the fetch onto an internal one), caps the body at 5MB, narrows to
`<main>`/`<article>` when present, and runs the markup through `sanitize-html`
— no scripts, styles, iframes, forms or event handlers, and every relative URL
made absolute.

That sanitized markup is rendered into the page rather than a sandboxed
iframe, because a cross-origin iframe would hide the two things the agent
needs: where you've scrolled, and what you've selected. **Sanitization is the
security boundary here** — the viewer must only ever render markup that came
back from this endpoint.

## Notes

- `zod` is pinned to `^4.4.3` to match the version the SDK resolves; a
  mismatched major makes `zodInput()` fail to typecheck against the SDK's
  declarations.
- The SDK's clients are single-attempt — one `connect()` each. Opening a
  different document tears the client down and builds a new one.
