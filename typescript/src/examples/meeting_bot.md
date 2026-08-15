# Meeting bot

A bot that joins a Zoom / Meet call as a participant, transcribes the
conversation in real time, and writes a follow-up summary to the workspace
when the meeting ends. Audio in and out only — no image stream is needed.
The Cosmo Assistant is engaged so the bot can delegate drafting the
post-meeting note.

```ts
import { RealtimeClient } from 'cosmo-ai';

const client = new RealtimeClient();
const agent = client.agent({
  tools: [{ kind: 'web_search' }],
});
const session = await agent.start();

session.on('transcript', (t) => persistLiveTranscript(t));
```

Requested server tools: `web_search` (typed opt-in).
