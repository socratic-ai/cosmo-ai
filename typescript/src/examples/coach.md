# Coach

A real-time presentation / interview coach that watches the user through webcam
and gives spoken feedback on posture, eye contact, and verbal delivery. The
agent listens (audio), sees the user (image stream), and speaks back. The
Cosmo Assistant is engaged so coaching can pull in workspace-specific
rubrics and prior session notes.

```ts
import { RealtimeClient } from 'cosmo-ai';

const client = new RealtimeClient();
const agent = client.agent({
  tools: [{ kind: 'web_search' }, { kind: 'examine_image' }],
});
const session = await agent.start();

const cam = await navigator.mediaDevices.getUserMedia({ video: true });
const streamId = await session.addVideoStream(cam, { fps: 2 });

// …later, when the session ends:
await session.removeVideoStream(streamId);
await session.end();
```

Requested server tools: `web_search`, `examine_image` (typed opt-ins).
