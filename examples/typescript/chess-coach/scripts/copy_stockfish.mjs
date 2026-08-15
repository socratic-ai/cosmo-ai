/**
 * Copies the single-threaded lite Stockfish build into public/ so Vite
 * serves it as-is: the engine .js runs directly as a web worker and fetches
 * its .wasm relative to its own URL, which bundling would break.
 */

import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(
  dirname(createRequire(import.meta.url).resolve('stockfish/package.json')),
  'bin',
);
const out = join(here, '..', 'public', 'stockfish');

mkdirSync(out, { recursive: true });
for (const file of [
  'stockfish-18-lite-single.js',
  'stockfish-18-lite-single.wasm',
]) {
  copyFileSync(join(bin, file), join(out, file));
}
console.log(`copied stockfish lite-single to ${out}`);
