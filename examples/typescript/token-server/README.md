# cosmo-token-server

The one backend piece an app built on the Cosmo realtime SDKs needs in
production. **You don't need this while developing**: locally, an API key
(passed directly, or resolved from `COSMO_API_KEY` / `cosmo login` — the
CLI installs with `pipx install cosmo-cli`) is the whole story. Deploy this when you distribute your app to end users. Your API key is a server-side secret; an app you distribute (a
web app, a Mac app, a phone app) must never contain it. This server holds
the key and trades it for short-lived end-user tokens instead:

```
end-user app ──POST /token──▶ this server ──POST /api/v1/external/auth/token──▶ Cosmo
   (no key)                   (holds COSMO_API_KEY)                    { jwt, expires_at }
```

The returned JWT is scoped to one end user, expires after 24 hours, can open
realtime sessions, and cannot mint further tokens or dial phone numbers.
Every Cosmo SDK fetches from this server directly — no token code in your
app:

```ts
// TypeScript
const client = new RealtimeClient({
  token: TokenSource.endpoint('https://your-deploy.example.com/token', {
    headers: { Authorization: `Bearer ${MINT_SECRET}`, 'X-External-User-Id': userId },
  }),
});
```

```python
# Python
client = RealtimeClient(token=TokenSource.endpoint(
    "https://your-deploy.example.com/token",
    headers={"Authorization": f"Bearer {MINT_SECRET}", "X-External-User-Id": user_id},
))
```

```swift
// Swift
let session = try await RealtimeSession.start(
  .init(credential: .tokenSource(.endpoint(
    URL(string: "https://your-deploy.example.com/token")!,
    headers: ["Authorization": "Bearer \(mintSecret)", "X-External-User-Id": userId]
  ))),
  config: config
)
```

The SDKs cache the token and re-fetch as expiry nears; your app never
handles refresh.

## What it is

`handler.js` — a single zero-dependency file written against the
web-standard fetch API. `POST /token` authenticates the caller, forwards to
Cosmo, and passes the response through. `server.js` adapts it to Node,
`lambda.js` to AWS Lambda; Workers/Deno/Vercel/Netlify/Bun run `handler.js`
natively.

| Env var | Meaning |
|---|---|
| `COSMO_API_KEY` | **Required.** Use a key with only the `user_tokens:mint` scope (a provisioning key: it can mint, but never open sessions or dial). |
| `MINT_SECRET` | Enables the out-of-the-box auth mode (see below). |
| `ALLOWED_ORIGIN` | Lock CORS to your app's origin. Default `*`. |
| `COSMO_BASE_URL` | Non-production Cosmo backend. Default `https://platform.askcosmo.ai`. |
| `PORT` | `node server.js` port. Default `8787`. |

## Authenticating YOUR users

Minting spends your workspace's money, so `/token` must know who it's
minting for. Two modes:

- **Out of the box (`MINT_SECRET` set):** callers send
  `Authorization: Bearer <MINT_SECRET>` and name the user in an
  `X-External-User-Id` header (or `external_user_id` in the JSON body).
  Right for server-to-server calls and closed betas. Know the limit: a
  secret embedded in a shipped binary can be extracted, so it does not
  protect an app distributed to strangers.
- **Production:** replace `identifyUser()` in `handler.js` (clearly marked)
  with your real auth — verify the session cookie / Firebase / Clerk /
  Supabase / your own JWT your app already sends, and return your stable id
  for that user. Ten lines, and the only part of this file you edit.

Nothing else is configured: minting is idempotent per
`(workspace, external_user_id)`, and Cosmo meters usage per that id.

## Run it

Local (Node 18+):

```bash
cp .env.example .env   # set COSMO_API_KEY (+ MINT_SECRET)
export MINT_SECRET=dev-secret
COSMO_API_KEY=cosmo_... node server.js
curl -s -X POST localhost:8787/token \
  -H "Authorization: Bearer $MINT_SECRET" -H 'X-External-User-Id: user-123'
# → {"jwt":"eyJ...","expires_at":"..."}
```

Deploy — it's one stateless HTTP endpoint, so anything runs it:

| Target | Recipe |
|---|---|
| **Cloudflare Workers** | `npx wrangler deploy` then `npx wrangler secret put COSMO_API_KEY` (and `MINT_SECRET`). Free tier (100k req/day, no card) covers a token endpoint indefinitely. |
| **Vercel** | Drop `handler.js` behind a route: `export const POST = (req) => handler.fetch(req, process.env)` in an app-route file, `vercel env add COSMO_API_KEY`, `vercel deploy --prod`. |
| **Deno Deploy** | `Deno.serve((req) => handler.fetch(req, Deno.env.toObject()))` wrapper, `deployctl deploy`. |
| **AWS Lambda** | Upload the folder, handler `lambda.handler`, add a Function URL, set env vars. |
| **Any Node host** (Railway, Render, Fly, a VM) | `npm start` with the env vars set. |

Already have a backend? Skip this repo: add one route that calls
`mintToken` with your server's SDK client and return `{ jwt, expires_at }`
— any endpoint speaking that shape works with `TokenSource.endpoint`.

## Hardening notes

- Prefer a provisioning key (`user_tokens:mint` only). If the key ever
  leaks, it can create users and mint — but not join sessions, dial, or
  read data.
- Set `ALLOWED_ORIGIN` for browser apps.
- Rate limiting: put your platform's limiter in front for public deploys;
  workspace session caps bound the spend blast radius on the Cosmo side.
- Rotating `COSMO_API_KEY` does not invalidate already-minted JWTs; they
  live out their 24h against the workspace.
