# Production credentials: the token server and end-user tokens

The one backend piece a shipped app needs. Local dev never needs this —
after `cosmo login`, the API key is the whole story. The full lifecycle
(flow diagram, REST shapes, per-language snippets) is documented at
https://platform.askcosmo.ai/docs/production/end-user-credentials — don't
re-derive it; this file is the checklist and the gotchas.

## Productionization checklist

Taking a working prototype (API key on the laptop) to a shipped app —
copy this and work through it in order:

```
Production readiness:
- [ ] 1. Create a provisioning key (dashboard, `user_tokens:mint` only)
- [ ] 2. Stand up the mint endpoint (token-server template or own backend)
- [ ] 3. Wire real app auth into the endpoint (who is this user?)
- [ ] 4. Switch the app's credential to TokenSource.endpoint(...)
- [ ] 5. Verify: no `cosmo_…` string in the shipped bundle; token mints,
        session starts, and a revoked token is refused
```

Step 2's fastest path is the
[token-server template](https://github.com/socratic-ai/cosmo-ai/tree/main/examples/typescript/token-server)
— a single zero-dependency file that runs on Cloudflare Workers, Vercel,
Deno Deploy, AWS Lambda, or plain Node, and speaks the expected endpoint
shape out of the box. Step 5's bundle check is non-negotiable: grep the
built artifact for `cosmo_` before shipping.

## Gotchas

- **A `cosmo login` CLI key cannot mint.** Minting needs the
  `user_tokens:mint` scope — the **User tokens — mint** checkbox on a
  dashboard-created key, unchecked by default. The right shape is a
  **provisioning key** with only that scope: it can mint but cannot join
  sessions, so a leaked minting credential grants no conversational
  access.
- **The mint endpoint must authenticate the caller** — minting spends the
  developer's workspace money. The template's `MINT_SECRET` mode is for
  server-to-server and closed betas only; a secret in a shipped binary
  can be extracted. Swap in real app auth at the marked `identifyUser()`
  seam.
- **`TokenSource` owns the refresh loop** — it POSTs the endpoint (empty
  JSON body), expects `{ jwt, expires_at }` (exactly what `mintToken`
  returns, so the route is a forward), caches, re-fetches near expiry,
  and drops its cache on a `401` session start. Hand raw JWT strings
  around instead and the refresh loop is yours.
- **A token only needs to be valid at session start** — an in-flight
  session is not cut off by its token expiring.
- **Revocation is per-token** (`token_id` from the mint response, DELETE
  endpoint, takes effect on the next request; a running session is not
  ended). **Rotating the API key does not invalidate JWTs it already
  minted** — they live out their expiry unless revoked individually.
- **Minted JWTs open sessions and nothing else** — no minting, no
  telephony dialing. Anything that spends money on the phone network
  stays behind the developer's key.
- `external_user_id` is the developer's own stable user id (1–128
  chars) — it's the join key for per-user usage attribution, and minting
  is idempotent per `(workspace, external_user_id)`.
