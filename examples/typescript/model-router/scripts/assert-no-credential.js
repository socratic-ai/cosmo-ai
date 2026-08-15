/**
 * Vite inlines every VITE_* variable it finds, so a `.env` left in place for
 * local dev will bake a live workspace key into a bundle meant to be served
 * to the public. `npm run pages:build` blanks the variable; this refuses to
 * ship if anything that looks like a credential survived anyway.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const PATTERNS = [/cosmo_[0-9a-f]{32,}/, /cosmo_pat_[0-9a-f]{16,}/];

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

const hits = [];
for (const file of walk('dist')) {
  const text = readFileSync(file, 'utf8');
  for (const pattern of PATTERNS) {
    const match = pattern.exec(text);
    if (match) hits.push(`${file}: ${match[0].slice(0, 14)}…`);
  }
}

if (hits.length > 0) {
  console.error('Refusing to deploy — a credential is present in the built bundle:');
  for (const hit of hits) console.error(`  ${hit}`);
  process.exit(1);
}
console.log('dist/ carries no credential.');
