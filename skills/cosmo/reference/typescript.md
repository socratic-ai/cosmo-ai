# TypeScript (`cosmo-ai` on npm)

Read [core.md](core.md) first. Full API reference:
https://platform.askcosmo.ai/docs. This file is the TypeScript gotchas.

## Current shape

```ts
import { RealtimeClient } from 'cosmo-ai';

// Node: {} resolves COSMO_API_KEY, else the `cosmo login` credentials
// file. A browser page instead gets { token: ... } — a minted JWT or a
// TokenSource, never an API key.
const client = new RealtimeClient({});
const session = await client.agent({ instructions: 'You are terse.', voice: 'Puck' }).start();

for await (const event of session) {
  switch (event.type) {
    case 'ready': console.log(event.session_id); break;
    case 'transcript': console.log(`[${event.role}] ${event.text}`); break;
    case 'session-ended': console.log(event.reason); break;
  }
}
```

## Gotchas

- **Next.js route handlers / server components**: import from
  **`cosmo-ai/server`** — the root entry carries the React bindings and
  will not load under the `react-server` bundler condition.
- **Two event vocabularies, on purpose**: iteration yields wire frames
  with kebab-case names (`{ type: 'session-ended' }`); the
  `session.on(...)` callback layer is the normalized UI surface with
  snake_case names (`session_ended`). Two guarantees `on` makes:
  `session_ended` fires exactly once per session on any exit path, and
  late subscribers get the current `lifecycle` state (and an
  already-fired `ready`) replayed — attaching handlers after
  `agent.start()` resolves just works. Iteration stays the canonical
  form; reach for `on` only on code you don't own.
- **Tools**: `tool({...})` from `cosmo-ai/tool` with `zodInput` from
  `cosmo-ai/tool/zod` — the Zod schema drives the model-facing JSON
  Schema and validation; never hand-write a schema.
- **Slow tools**: `tool({ background: true, handler: async (args, job) =>
  … })`. The handler returns `void` — `job.ack('on it')` releases the
  reply so the agent keeps talking, then `await job.complete({ result,
  summary })` or `await job.fail({ error })` delivers the outcome
  whenever the work lands.
- **React**: wrap in `CosmoRealtimeProvider` and use the shipped hooks
  and components — the docs list them; don't rebuild transcript or
  mic-level plumbing by hand.

## Ship it

The browser-app walkthrough (mint route, deploy, 429 handling):
[../examples/share-a-web-app.md](../examples/share-a-web-app.md).
