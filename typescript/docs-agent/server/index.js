import express from 'express';
import dns from 'dns/promises';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

import { isBlockedAddress, readPage, screenHostLiterally } from '../shared/page.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const app = express();
app.use(express.json({ limit: '32kb' }));

// Node can resolve, so screen every answer rather than just the literal host.
async function screenHost(host) {
  screenHostLiterally(host);
  const bare = host.replace(/^\[|\]$/g, '');
  if (net.isIP(bare)) return;
  const addresses = (await dns.lookup(bare, { all: true })).map((r) => r.address);
  if (addresses.length === 0 || addresses.some(isBlockedAddress)) {
    throw new Error('That host resolves to a private or local address.');
  }
}

// Namespaced under /local because /api is proxied through to the Cosmo
// backend (see vite.config.ts).
app.post('/local/fetch-url', async (req, res) => {
  const { status, body } = await readPage(req.body?.url, screenHost);
  if (status !== 200) console.error('fetch-url failed', { target: req.body?.url, ...body });
  res.status(status).json(body);
});

const PORT = process.env.DOCS_AGENT_PORT || 7871;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`docs-agent url backend on http://localhost:${PORT}`);
});
