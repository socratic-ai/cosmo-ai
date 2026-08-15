// @vitest-environment jsdom
/**
 * In a browser-shaped runtime (a ``window`` exists) the resolution chain
 * must short-circuit to ``null`` without touching Node builtins, so a
 * credential-less browser client keeps its cookie / host-app behavior and
 * bundlers never execute the ``node:fs`` import.
 */

import { describe, expect, it } from 'vitest';

import { resolveCredentialFromRuntime } from '../credentials_file';

describe('browser guard', () => {
  it('resolution is a no-op where a window exists, even with env present', async () => {
    process.env.COSMO_API_KEY = 'cosmo_env_key';
    try {
      await expect(resolveCredentialFromRuntime()).resolves.toBeNull();
    } finally {
      delete process.env.COSMO_API_KEY;
    }
  });
});
