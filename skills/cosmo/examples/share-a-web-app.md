# Share a web app built on the Realtime SDK

Build a browser voice app a stranger can open from a link, with the
developer's API key never leaving the server. The full token lifecycle
(TTL, revocation, provisioning-key scope) is in
[reference/end-user-tokens.md](../reference/end-user-tokens.md).

## The shape — two halves, one codebase

- **Server half**: one Next.js route holding `COSMO_API_KEY`, minting
  short-lived JWTs. Import from **`cosmo-ai/server`** there — the root
  entry carries the React bindings, which the React Server context refuses
  to load.
- **Browser half**: a client component that fetches a token from the route,
  then talks to the Cosmo API directly with it (the API is CORS-open — no
  proxy needed).

The same code runs under `next dev` and deployed; only where
`COSMO_API_KEY` lives changes (`.env.local` vs deployment env var).

### Server route

```ts
// app/api/cosmo/token/route.ts
import { NextResponse } from 'next/server';
import { RealtimeClient } from 'cosmo-ai/server';

const client = new RealtimeClient({ apiKey: process.env.COSMO_API_KEY });

export async function POST(request: Request) {
  const externalUserId = request.headers.get('x-external-user-id');
  if (!externalUserId) {
    return NextResponse.json({ error: 'X-External-User-Id is required' }, { status: 400 });
  }
  return NextResponse.json(await client.mintToken(externalUserId));
}
```

### Browser page

```tsx
'use client';
import { useRef, useState } from 'react';
import { RealtimeClient, TokenSource, type RealtimeSession } from 'cosmo-ai';

export default function Home() {
  const [status, setStatus] = useState('idle');
  const sessionRef = useRef<RealtimeSession | null>(null);

  async function start() {
    // The SDK fetches the JWT from the route, caches it, and re-fetches
    // as expiry nears — no token plumbing in the page.
    const client = new RealtimeClient({
      token: TokenSource.endpoint('/api/cosmo/token', {
        headers: { 'X-External-User-Id': visitorId() },
      }),
    });
    const agent = client.agent({ instructions: '…', greeting: '…' });
    let session;
    try {
      session = await agent.start();
    } catch (err) {
      // Refresh-abandoned sessions are reclaimed automatically after a
      // short window; a fresh start can 429 until then. Say so instead
      // of showing the raw error.
      const busy = (err as { status?: number }).status === 429;
      setStatus(busy ? 'demo busy — try again in a minute' : 'failed');
      return;
    }
    sessionRef.current = session;

    // lifecycle sees every transition, both directions, and the current
    // state is replayed on subscribe — this is the whole status UI.
    session.on('lifecycle', (s) => {
      if (s.kind === 'connected') setStatus('live');
      if (s.kind === 'disconnected') setStatus(`ended (${s.disconnectReason ?? 'unknown'})`);
    });
  }

  async function stop() {
    // A clean end frees the server slot immediately (no 429 on restart).
    await sessionRef.current?.end();
    sessionRef.current = null;
  }
  // … buttons + transcript rendering (coalesce transcript events by
  // `${turnId}-${role}`, append when event.append is true)
}

function visitorId(): string {
  const existing = localStorage.getItem('visitor_id');
  if (existing) return existing;
  const id = `visitor-${crypto.randomUUID()}`;
  localStorage.setItem('visitor_id', id);
  return id;
}
```

(`session_ended` also fires exactly once on any exit path — client end
included — so keying "call over" UI to it works equally well.)

## Key setup (ask the user to do this part)

The key must carry the `user_tokens:mint` scope — the **User tokens — mint**
checkbox in the create dialog, unchecked by default
(`/<workspace>/developer/api-keys`). A `cosmo login` CLI key does not
carry this scope, so this step always needs a dashboard-created key.
Recommend a dedicated key for the shared app so it can be revoked
independently. Visitors' sessions bill the developer's workspace.

## Deploy (drive this for the user)

```bash
npm i -g vercel
vercel login          # user does this once — browser OAuth
vercel link --yes
printf '%s' "$COSMO_API_KEY" | vercel env add COSMO_API_KEY production
vercel deploy --prod --yes
```

- `vercel login` with **Continue with Google** fails for Google Workspace
  orgs with `admin_policy_enforced` — have the user pick GitHub or email.
- Verify after deploy: `curl -s -X POST <url>/api/cosmo/token -H 'X-External-User-Id: smoke-1'`
  must return `{"jwt":...}`, then open the page and start a session.
