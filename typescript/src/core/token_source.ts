/**
 * ``TokenSource`` — the credential shape for distributed apps.
 *
 * A shipped app must not hold an API key, and a static minted JWT expires
 * after 24 hours. A ``TokenSource`` closes the gap: it knows how to fetch a
 * fresh ``MintedToken`` from the developer's own backend, caches it in
 * memory, and re-fetches when the cached token nears expiry — so
 * ``new RealtimeClient({ token: TokenSource.endpoint(...) })`` stays valid
 * for the life of the process with no refresh code in the app.
 */

import { MintTokenError, type MintedToken } from './auth';
import { log } from './logger';
import { parseErrorDetail } from '../transport/error_detail';
import { describeFetchFailure } from '../transport/fetch_failure';

/** Re-fetch this long before ``expiresAt`` so an in-flight session start
 *  never races the expiry boundary. Matches the cross-SDK contract
 *  (``token-source-vectors.json``). */
const REFRESH_SKEW_MS = 60_000;

/** What a ``TokenSource.custom`` fetcher resolves with: the minted JWT and
 *  its expiry (a ``Date``, or the RFC 3339 string straight off a mint
 *  response). */
export type FetchedToken = { jwt: string; expiresAt: Date | string };

export type TokenSourceEndpointOptions = {
  /** Headers attached to every token request — the app's own auth (its
   *  session cookie rides automatically only same-origin; a bearer or
   *  custom header goes here). Static, or a (possibly async) callback
   *  resolved per fetch. */
  headers?:
    | Record<string, string>
    | (() => Record<string, string> | Promise<Record<string, string>>);
};

/** A credential that fetches — and keeps fresh — a minted end-user token.
 *
 *  Pass one as ``token`` in ``RealtimeClientOptions``. The client asks the
 *  source for a JWT whenever a request needs auth; the source reuses its
 *  cached token while comfortably within its lifetime and re-fetches
 *  otherwise. A session-start rejected with HTTP 401 drops the cache, so
 *  the next start fetches fresh.
 *
 *  Two constructors:
 *
 *  - ``TokenSource.endpoint(url)`` — POST a token endpoint that returns
 *    ``{ jwt, expires_at }`` (the shape ``mintToken`` responses already
 *    have; any backend that forwards ``POST auth/token`` qualifies).
 *  - ``TokenSource.custom(fn)`` — any async function resolving with
 *    ``{ jwt, expiresAt }`` — full control over transport and auth.
 */
export class TokenSource {
  readonly #fetchToken: () => Promise<MintedToken>;
  #cached: MintedToken | null = null;
  #inflight: Promise<MintedToken> | null = null;

  private constructor(fetchToken: () => Promise<MintedToken>) {
    this.#fetchToken = fetchToken;
  }

  /** A source that POSTs ``url`` (empty JSON body) and reads
   *  ``{ jwt, expires_at }`` from the response — the wire shape of
   *  ``POST /api/v1/external/auth/token`` and of the token-server
   *  template. Rejections surface as ``MintTokenError`` carrying
   *  the server's error slug when the body parses, else an
   *  ``http_<status>`` synthetic; local failures carry
   *  ``token_source_failed``. An absolute ``url`` must be https
   *  (http only for localhost) — auth headers and JWTs must not cross
   *  the network in the clear; a relative ``url`` rides the page's own
   *  origin. */
  static endpoint(url: string, options: TokenSourceEndpointOptions = {}): TokenSource {
    assertSupportedEndpointUrl(url);
    return new TokenSource(() => postTokenEndpoint(url, options));
  }

  /** A source backed by ``fetchToken`` — called whenever a fresh token is
   *  needed. Resolve with ``{ jwt, expiresAt }``; a malformed result
   *  raises ``MintTokenError('token_source_failed')``. */
  static custom(fetchToken: () => Promise<FetchedToken>): TokenSource {
    return new TokenSource(async () => normalizeFetched(await fetchToken()));
  }

  /** @internal The JWT to send right now: cached while it has more than
   *  the refresh skew left, else one shared re-fetch (concurrent callers
   *  await the same request). */
  async _getJwt(): Promise<string> {
    if (
      this.#cached !== null &&
      this.#cached.expiresAt.getTime() - Date.now() > REFRESH_SKEW_MS
    ) {
      return this.#cached.jwt;
    }
    this.#inflight ??= this.#fetchToken()
      .then((minted) => {
        this.#cached = minted;
        return minted;
      })
      .finally(() => {
        this.#inflight = null;
      });
    return (await this.#inflight).jwt;
  }

  /** @internal Drop the cached token so the next ``_getJwt`` re-fetches. */
  _invalidate(): void {
    this.#cached = null;
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function assertSupportedEndpointUrl(url: string): void {
  // Classify the way fetch will actually resolve it — prefix checks miss
  // the normalizations browsers apply (leading whitespace stripped,
  // backslashes read as slashes). Resolving against two sentinel bases
  // separates the three cases: a truly relative path lands on whichever
  // sentinel resolved it (safe: fetch sends it to the page's own origin);
  // a scheme-relative ``//host`` inherits the base's scheme, so the two
  // resolutions disagree (refused: an http page would send auth headers
  // to remote plaintext); an absolute URL resolves identically under both
  // and its scheme/host are checked.
  let asHttps: URL;
  let asHttp: URL;
  try {
    asHttps = new URL(url, 'https://cosmo-relative.invalid');
    asHttp = new URL(url, 'http://cosmo-relative.invalid');
  } catch {
    throw new MintTokenError(
      'token_source_failed',
      `TokenSource.endpoint could not be parsed as a URL: ${JSON.stringify(url)}`,
    );
  }
  if (asHttps.hostname === 'cosmo-relative.invalid' && asHttp.hostname === 'cosmo-relative.invalid') {
    return; // relative — resolves against the page's own origin
  }
  if (asHttps.protocol !== asHttp.protocol) {
    throw new MintTokenError(
      'token_source_failed',
      'TokenSource.endpoint must be an absolute https URL or a relative path, not scheme-relative.',
    );
  }
  if (asHttps.protocol === 'https:') return;
  if (asHttps.protocol === 'http:' && LOCAL_HOSTS.has(asHttps.hostname)) return;
  throw new MintTokenError(
    'token_source_failed',
    'TokenSource.endpoint must use https:// (http is allowed only for localhost).',
  );
}

function normalizeFetched(fetched: FetchedToken): MintedToken {
  const jwt = fetched?.jwt;
  const raw = fetched?.expiresAt;
  const expiresAt = raw instanceof Date ? raw : new Date(raw ?? '');
  if (typeof jwt !== 'string' || jwt.length === 0 || Number.isNaN(expiresAt.getTime())) {
    throw new MintTokenError(
      'token_source_failed',
      'TokenSource.custom fetcher must resolve with { jwt, expiresAt }.',
    );
  }
  return { jwt, expiresAt };
}

async function postTokenEndpoint(
  url: string,
  options: TokenSourceEndpointOptions,
): Promise<MintedToken> {
  const extra =
    typeof options.headers === 'function' ? await options.headers() : (options.headers ?? {});
  let response: Response;
  try {
    // ``redirect: 'error'``: following one could silently downgrade the
    // exchange (an https endpoint answering 30x to plain http) — refuse.
    response = await fetch(url, {
      method: 'POST',
      headers: { ...extra, 'Content-Type': 'application/json' },
      body: '{}',
      redirect: 'error',
    });
  } catch (err) {
    throw new MintTokenError('token_source_failed', describeFetchFailure(url, err));
  }
  if (!response.ok) {
    const { code, message } = await parseErrorDetail(response);
    log.warn('[realtime] token source rejected', { status: response.status, code });
    throw new MintTokenError(code, message);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new MintTokenError(
      'token_source_failed',
      'Token endpoint response was not JSON.',
    );
  }
  const obj = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const jwt = obj.jwt;
  // ``expires_at`` is the wire shape (a forwarded mint response);
  // ``expiresAt`` is a serialized SDK ``MintedToken`` — a backend returning
  // its ``mintToken()`` result as-is emits this spelling.
  const expiresAtRaw = obj.expires_at ?? obj.expiresAt;
  const expiresAt = typeof expiresAtRaw === 'string' ? new Date(expiresAtRaw) : new Date(NaN);
  if (typeof jwt !== 'string' || jwt.length === 0 || Number.isNaN(expiresAt.getTime())) {
    throw new MintTokenError(
      'token_source_failed',
      'Token endpoint response missing jwt / expires_at.',
    );
  }
  return { jwt, expiresAt };
}
