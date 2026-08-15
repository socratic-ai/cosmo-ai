# Cooking partner

A hands-free kitchen companion. The user talks to the agent while it watches
the stovetop / cutting board through a phone or external camera. The agent
guides recipe steps, warns about heat / timing, and reads back amounts. The
Cosmo Assistant handles the recipe knowledge graph; a `set_timer` tool lets
the agent kick off countdowns without escalating the assistant on every turn.

```ts
import { RealtimeClient } from 'cosmo-ai';

const client = new RealtimeClient();
const agent = client.agent({
  tools: [
    { kind: 'web_search' },
    {
      kind: 'client',
      name: 'set_timer',
      description: 'Start a kitchen countdown timer.',
      parameters: {
        type: 'object',
        properties: { seconds: { type: 'integer' } },
        required: ['seconds'],
      },
      handler: async ({ seconds }) => startTimer(seconds as number),
    },
  ],
});
const session = await agent.start();

const cam = await navigator.mediaDevices.getUserMedia({
  video: { facingMode: 'environment' },
});
const streamId = await session.addVideoStream(cam, { id: 'stovetop', fps: 1 });
```

Requested server tools: `web_search` (typed opt-in); `set_timer` runs on the
client.
