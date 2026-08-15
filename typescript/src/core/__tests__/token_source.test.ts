/** TokenSource — fetch/cache/refresh semantics for the third credential
 *  kind. The cache decision table mirrors the cross-SDK contract in
 *  ``token-source-vectors.json``. */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { TokenSource } from '../token_source';
import { RealtimeClient } from '../realtime_client';
import { CredentialError, MintTokenError } from '../auth';

const TOKEN_URL = 'https://myapp.example.com/token';

function mintBody(expiresInMs: number): unknown {
  return {
    jwt: `jwt-${expiresInMs}`,
    expires_at: new Date(Date.now() + expiresInMs).toISOString(),
  };
}

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function errorResponse(status: number, body: unknown): Response {
  return {
    ok: false,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-04T12:00:00Z'));
  global.fetch = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('TokenSource.endpoint wire shape', () => {
  it('POSTs an empty JSON body and parses { jwt, expires_at }', async () => {
    (global.fetch as Mock).mockResolvedValueOnce(okResponse(mintBody(DAY_MS)));
    const source = TokenSource.endpoint(TOKEN_URL);

    const jwt = await source._getJwt();

    expect(jwt).toBe(`jwt-${DAY_MS}`);
    expect(global.fetch).toHaveBeenCalledWith(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      redirect: 'error',
    });
  });

  it('attaches static headers and resolves callback headers per fetch', async () => {
    (global.fetch as Mock).mockResolvedValue(okResponse(mintBody(DAY_MS)));

    await TokenSource.endpoint(TOKEN_URL, {
      headers: { Authorization: 'Bearer app-session' },
    })._getJwt();
    expect((global.fetch as Mock).mock.calls[0][1].headers).toMatchObject({
      Authorization: 'Bearer app-session',
    });

    const dynamic = vi.fn().mockResolvedValue({ 'X-App-Auth': 'nonce-1' });
    await TokenSource.endpoint(TOKEN_URL, { headers: dynamic })._getJwt();
    expect(dynamic).toHaveBeenCalledTimes(1);
    expect((global.fetch as Mock).mock.calls[1][1].headers).toMatchObject({
      'X-App-Auth': 'nonce-1',
    });
  });

  it('refuses a plaintext remote endpoint at construction', () => {
    expect(() => TokenSource.endpoint('http://myapp.example.com/token')).toThrow(
      MintTokenError,
    );
    expect(() => TokenSource.endpoint('http://localhost:8787/token')).not.toThrow();
    expect(() => TokenSource.endpoint('/api/cosmo/token')).not.toThrow();
  });

  it('refuses non-http schemes even on loopback', () => {
    expect(() => TokenSource.endpoint('ftp://localhost/token')).toThrow(MintTokenError);
    expect(() => TokenSource.endpoint('ws://localhost/token')).toThrow(MintTokenError);
  });

  it.each([
    ['plain', '//tokens.example/token'],
    ['leading whitespace', ' //tokens.example/token'],
    ['backslashes', '\\\\tokens.example/token'],
    ['mixed slash', '/\\tokens.example/token'],
  ])('refuses scheme-relative URLs (%s) — they resolve to a foreign host', (_name, url) => {
    expect(() => TokenSource.endpoint(url)).toThrow(MintTokenError);
  });

  it('still accepts true relative paths', () => {
    expect(() => TokenSource.endpoint('/api/cosmo/token')).not.toThrow();
    expect(() => TokenSource.endpoint('./token')).not.toThrow();
    expect(() => TokenSource.endpoint('token')).not.toThrow();
  });

  it('accepts the serialized-MintedToken spelling expiresAt', async () => {
    (global.fetch as Mock).mockResolvedValueOnce(
      okResponse({ jwt: 'j-alias', expiresAt: new Date(Date.now() + DAY_MS).toISOString() }),
    );
    expect(await TokenSource.endpoint(TOKEN_URL)._getJwt()).toBe('j-alias');
  });

  it('surfaces the server slug on a parseable rejection', async () => {
    (global.fetch as Mock).mockResolvedValueOnce(
      errorResponse(403, { error: { type: 'api_error', message: 'nope' } }),
    );
    await expect(TokenSource.endpoint(TOKEN_URL)._getJwt()).rejects.toMatchObject({
      name: 'MintTokenError',
      code: 'api_error',
    });
  });

  it('prefers a flattened envelope code over its type', async () => {
    (global.fetch as Mock).mockResolvedValueOnce(
      errorResponse(403, {
        error: { type: 'api_error', code: 'user_token_disabled', message: 'off' },
      }),
    );
    await expect(TokenSource.endpoint(TOKEN_URL)._getJwt()).rejects.toMatchObject({
      code: 'user_token_disabled',
      message: 'off',
    });
  });

  it.each([
    ['network failure', () => (global.fetch as Mock).mockRejectedValueOnce(new TypeError('down'))],
    [
      'non-JSON success body',
      () =>
        (global.fetch as Mock).mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError('bad json');
          },
        } as unknown as Response),
    ],
    [
      'missing jwt / expires_at',
      () => (global.fetch as Mock).mockResolvedValueOnce(okResponse({ jwt: '' })),
    ],
  ])('maps %s to token_source_failed', async (_name, arrange) => {
    arrange();
    await expect(TokenSource.endpoint(TOKEN_URL)._getJwt()).rejects.toMatchObject({
      name: 'MintTokenError',
      code: 'token_source_failed',
    });
  });
});

describe('TokenSource.custom', () => {
  it('accepts a Date or an RFC 3339 string for expiresAt', async () => {
    const asDate = TokenSource.custom(async () => ({
      jwt: 'j1',
      expiresAt: new Date(Date.now() + DAY_MS),
    }));
    const asString = TokenSource.custom(async () => ({
      jwt: 'j2',
      expiresAt: new Date(Date.now() + DAY_MS).toISOString(),
    }));
    expect(await asDate._getJwt()).toBe('j1');
    expect(await asString._getJwt()).toBe('j2');
  });

  it('rejects a malformed fetcher result with token_source_failed', async () => {
    const source = TokenSource.custom(
      async () => ({ jwt: 'j', expiresAt: 'not-a-date' }) as never,
    );
    await expect(source._getJwt()).rejects.toMatchObject({
      code: 'token_source_failed',
    });
  });
});

describe('cache and refresh', () => {
  it('reuses the cached token while it has more than the skew left', async () => {
    (global.fetch as Mock).mockResolvedValue(okResponse(mintBody(DAY_MS)));
    const source = TokenSource.endpoint(TOKEN_URL);

    await source._getJwt();
    vi.advanceTimersByTime(DAY_MS - 61_000);
    await source._getJwt();

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('re-fetches once the cached token is within the 60s refresh skew', async () => {
    (global.fetch as Mock)
      .mockResolvedValueOnce(okResponse(mintBody(DAY_MS)))
      .mockResolvedValueOnce(okResponse(mintBody(2 * DAY_MS)));
    const source = TokenSource.endpoint(TOKEN_URL);

    await source._getJwt();
    vi.advanceTimersByTime(DAY_MS - 59_000);
    const jwt = await source._getJwt();

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(jwt).toBe(`jwt-${2 * DAY_MS}`);
  });

  it('invalidate() drops the cache so the next call re-fetches', async () => {
    (global.fetch as Mock).mockResolvedValue(okResponse(mintBody(DAY_MS)));
    const source = TokenSource.endpoint(TOKEN_URL);

    await source._getJwt();
    source._invalidate();
    await source._getJwt();

    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('concurrent callers share one in-flight fetch', async () => {
    let release!: (r: Response) => void;
    (global.fetch as Mock).mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );
    const source = TokenSource.endpoint(TOKEN_URL);

    const first = source._getJwt();
    const second = source._getJwt();
    release(okResponse(mintBody(DAY_MS)));

    expect(await first).toBe(await second);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('a failed fetch is not cached — the next call tries again', async () => {
    (global.fetch as Mock)
      .mockRejectedValueOnce(new TypeError('down'))
      .mockResolvedValueOnce(okResponse(mintBody(DAY_MS)));
    const source = TokenSource.endpoint(TOKEN_URL);

    await expect(source._getJwt()).rejects.toBeInstanceOf(MintTokenError);
    expect(await source._getJwt()).toBe(`jwt-${DAY_MS}`);
  });
});

describe('RealtimeClient with a TokenSource credential', () => {
  it('counts as the token credential: pairing with apiKey is rejected', () => {
    expect(
      () =>
        new RealtimeClient({
          apiKey: 'sk-secret',
          token: TokenSource.endpoint(TOKEN_URL),
        }),
    ).toThrow(CredentialError);
  });

  it('cannot mint', async () => {
    const client = new RealtimeClient({ token: TokenSource.endpoint(TOKEN_URL) });
    await expect(client.mintToken('user-1')).rejects.toMatchObject({
      name: 'MintTokenError',
      code: 'no_api_key',
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('sends the fetched JWT as the Bearer on API requests', async () => {
    (global.fetch as Mock)
      .mockResolvedValueOnce(okResponse(mintBody(DAY_MS)))
      .mockResolvedValueOnce(
        okResponse({
          credential: 'user_token',
          workspace: null,
          scopes: ['realtime:use'],
          can_start_sessions: true,
          realtime_voice_available: true,
          external_user_id: 'user-1',
        }),
      );
    const client = new RealtimeClient({ token: TokenSource.endpoint(TOKEN_URL) });

    const info = await client.verify();

    expect(info.credential).toBe('user_token');
    const verifyCall = (global.fetch as Mock).mock.calls[1];
    expect(verifyCall[0]).toContain('/realtime/verify');
    expect(verifyCall[1].headers).toMatchObject({
      Authorization: `Bearer jwt-${DAY_MS}`,
    });
  });
});
