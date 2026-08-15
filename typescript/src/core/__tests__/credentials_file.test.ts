/**
 * The impure layer of zero-argument credential resolution: the Node runtime
 * wrapper (real files, real env) and what ``RealtimeClient`` does with the
 * result. Chain semantics are pinned by the shared conformance vectors.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CredentialError } from '../auth';
import { resolveCredentialFromRuntime } from '../credentials_file';
import { RealtimeClient } from '../realtime_client';

const VALID_FILE = `version = 1

[default]
slug = "acme"
api_key = "cosmo_file_key"
api_key_id = "key-1"
base_url = "https://app.askcosmo.ai"
expires_at = "2099-01-01T00:00:00Z"
`;

let dir: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'COSMO_API_KEY',
  'COSMO_BASE_URL',
  'COSMO_PROFILE',
  'COSMO_CREDENTIALS_FILE',
];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cosmo-creds-'));
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function writeCredentials(content: string): string {
  const path = join(dir, 'credentials');
  writeFileSync(path, content);
  return path;
}

describe('resolveCredentialFromRuntime', () => {
  it('resolves COSMO_API_KEY without touching the filesystem', async () => {
    process.env.COSMO_API_KEY = 'cosmo_env_key';
    process.env.COSMO_CREDENTIALS_FILE = join(dir, 'does-not-exist');
    const resolved = await resolveCredentialFromRuntime();
    expect(resolved).toEqual({ apiKey: 'cosmo_env_key', baseUrl: null, source: 'env' });
  });

  it('reads the file named by COSMO_CREDENTIALS_FILE', async () => {
    process.env.COSMO_CREDENTIALS_FILE = writeCredentials(VALID_FILE);
    const resolved = await resolveCredentialFromRuntime();
    expect(resolved).toEqual({
      apiKey: 'cosmo_file_key',
      baseUrl: 'https://app.askcosmo.ai',
      source: 'file',
    });
  });

  it('returns null (credential-less mode) when nothing resolves', async () => {
    process.env.COSMO_CREDENTIALS_FILE = join(dir, 'does-not-exist');
    await expect(resolveCredentialFromRuntime()).resolves.toBeNull();
  });

  it('still throws on an unusable file — the user set up file auth', async () => {
    process.env.COSMO_CREDENTIALS_FILE = writeCredentials('version = 99\n');
    await expect(resolveCredentialFromRuntime()).rejects.toMatchObject({
      name: 'CredentialError',
      code: 'file_invalid',
    });
  });

  it('throws expired with a cosmo login remediation', async () => {
    process.env.COSMO_CREDENTIALS_FILE = writeCredentials(
      VALID_FILE.replace('2099-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
    );
    let thrown: unknown;
    try {
      await resolveCredentialFromRuntime();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CredentialError);
    expect((thrown as CredentialError).code).toBe('expired');
    expect((thrown as CredentialError).message).toContain('cosmo login');
  });
});

describe('RealtimeClient zero-argument construction', () => {
  it('adopts the file credential and its base_url before the first request', async () => {
    process.env.COSMO_CREDENTIALS_FILE = writeCredentials(VALID_FILE);
    const client = new RealtimeClient({});
    // Construction is sync and lazy — baseUrl still the default here.
    expect(client.baseUrl).toBe('https://platform.askcosmo.ai');

    const seen: { url: string; auth: string | undefined }[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        url: String(url),
        auth: (init?.headers as Record<string, string>)?.Authorization,
      });
      return new Response(JSON.stringify({}), { status: 500 });
    }) as typeof fetch;
    try {
      await client.verify().catch(() => undefined);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(seen).toHaveLength(1);
    expect(seen[0].url.startsWith('https://app.askcosmo.ai/')).toBe(true);
    expect(seen[0].auth).toBe('Bearer cosmo_file_key');
    expect(client.baseUrl).toBe('https://app.askcosmo.ai');
  });

  it('a zero-argument client with an env key can mint', async () => {
    process.env.COSMO_API_KEY = 'cosmo_env_key';
    const client = new RealtimeClient({});
    const originalFetch = globalThis.fetch;
    let auth: string | undefined;
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      auth = (init?.headers as Record<string, string>)?.Authorization;
      return new Response(
        JSON.stringify({ jwt: 'jwt_abc', expires_at: '2099-01-01T00:00:00Z' }),
        { status: 200 },
      );
    }) as typeof fetch;
    try {
      const minted = await client.mintToken('user-1');
      expect(minted.jwt).toBe('jwt_abc');
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(auth).toBe('Bearer cosmo_env_key');
  });

  it('with nothing to resolve, mintToken still fails with no_api_key', async () => {
    process.env.COSMO_CREDENTIALS_FILE = join(dir, 'does-not-exist');
    const client = new RealtimeClient({});
    await expect(client.mintToken('user-1')).rejects.toMatchObject({
      name: 'MintTokenError',
      code: 'no_api_key',
    });
  });

  it('an explicit credential skips resolution entirely', async () => {
    process.env.COSMO_API_KEY = 'cosmo_env_key';
    const client = new RealtimeClient({ token: 'jwt_explicit' });
    const originalFetch = globalThis.fetch;
    let auth: string | undefined;
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      auth = (init?.headers as Record<string, string>)?.Authorization;
      return new Response(JSON.stringify({}), { status: 500 });
    }) as typeof fetch;
    try {
      await client.verify().catch(() => undefined);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(auth).toBe('Bearer jwt_explicit');
  });

  it('a getAuthHeaders client never runs the chain', async () => {
    process.env.COSMO_API_KEY = 'cosmo_env_key';
    const client = new RealtimeClient({
      getAuthHeaders: () => ({ Authorization: 'Bearer host_app_jwt' }),
    });
    const originalFetch = globalThis.fetch;
    let auth: string | undefined;
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      auth = (init?.headers as Record<string, string>)?.Authorization;
      return new Response(JSON.stringify({}), { status: 500 });
    }) as typeof fetch;
    try {
      await client.verify().catch(() => undefined);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(auth).toBe('Bearer host_app_jwt');
  });
});
