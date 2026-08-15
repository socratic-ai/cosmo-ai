# CLI

A terminal-resident voice client — push-to-talk, no UI surface, no camera.
Useful for embedded agents, scripted demos, and headless test harnesses.
Audio-only, no image stream — pure voice-plus-tools mode.

```ts
import { RealtimeClient } from 'cosmo-ai';

const client = new RealtimeClient({
  baseUrl: 'https://platform.askcosmo.ai',
  token: mintedEndUserJwt,
});
const agent = client.agent({
  tools: [{ kind: 'web_search' }],
});
const session = await agent.start();

process.stdin.on('data', (buf) => {
  const text = buf.toString().trim();
  if (text) void session.sendText(text);
});

process.on('SIGINT', () => {
  void session.end().finally(() => process.exit(0));
});
```

Requested server tools: `web_search` (typed opt-in).
