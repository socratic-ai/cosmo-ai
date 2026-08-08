/** Node 18+ adapter: `COSMO_API_KEY=cosmo_... node server.js`. */

import { createServer } from 'node:http';
import handler from './handler.js';

const port = Number(process.env.PORT ?? 8787);
// A token request is a header-sized payload; anything bigger is abuse.
const MAX_BODY_BYTES = 64 * 1024;

createServer(async (req, res) => {
  try {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        res.writeHead(413).end();
        req.destroy();
        return;
      }
      chunks.push(chunk);
    }
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers[name] = value;
    }
    const request = new Request(`http://${req.headers.host ?? `localhost:${port}`}${req.url}`, {
      method: req.method,
      headers,
      body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
    });
    const response = await handler.fetch(request, process.env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    // Malformed requests and upstream failures must answer, never crash
    // the process (an async listener's rejection is otherwise unhandled).
    console.error('token server request failed:', err);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'internal', message: 'internal error' } }));
  }
}).listen(port, () => {
  console.log(`cosmo token server listening on http://localhost:${port}`);
});
