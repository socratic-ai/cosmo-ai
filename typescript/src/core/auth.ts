/**
 * Credential model + mint-token REST unit for the Cosmo Realtime SDK.
 *
 * Mirrors the Python SDK's credential story: a client is constructed with an
 * **API key** (workspace-scoped, server-side only, can mint end-user tokens)
 * XOR a **user token** (a minted end-user JWT, safe on end-user devices, can
 * open sessions but cannot mint). Kept free of the ``livekit-client``
 * dependency (like ``transport/dial.ts``) — minting is a plain REST call.
 */

import { RealtimeError, ApiError } from './errors';
import { log } from './logger';
import { parseErrorDetail } from '../transport/error_detail';
import { describeFetchFailure } from '../transport/fetch_failure';

/** A minted end-user credential (``POST auth/token``). Hand ``jwt`` to the
 *  end user's device, which constructs ``new RealtimeClient({ token: jwt })``.
 *  Minting is idempotent per ``(workspace, externalUserId)`` — the same
 *  external user maps to the same auto-provisioned project on repeat calls.
 *  ``tokenId`` is the server-side revocation handle
 *  (``DELETE auth/token/{token_id}``) — keep it on your server; the device
 *  only needs ``jwt``. Cosmo always returns it; it is optional here because
 *  this type doubles as the ``TokenSource`` cached shape, whose contract is
 *  any backend returning ``{ jwt, expires_at }``. */
export type MintedToken = {
  /** The token itself. This is the only part a browser or device needs. */
  jwt: string;
  /** When the token stops being accepted. A ``TokenSource`` refreshes ahead
   *  of this by itself. */
  expiresAt: Date;
  /** Revocation handle — keep it server-side and pass it to
   *  ``DELETE auth/token/{tokenId}`` to kill the token early. Absent only
   *  when a custom token backend omitted it. */
  tokenId?: string;
};

/** Why the client has no usable credential.
 *
 *  Closed: every one is thrown by this SDK. The first five are the slugs the
 *  cross-SDK resolution vectors pin
 *  (`contract/credentials-resolution-vectors.json`); the rest cover a
 *  credential supplied in a way the SDK refuses to send. */
export type CredentialsErrorCode =
  /** Nothing to authenticate with: nothing passed, no `COSMO_API_KEY`, and no
   *  credentials file. The message names every way to supply one. */
  | 'no_credential'
  /** The requested profile is not in the credentials file. */
  | 'profile_not_found'
  /** The credentials file exists but cannot be used: not TOML, an unreadable
   *  version, or a profile missing required fields. */
  | 'file_invalid'
  /** The stored API key's `expires_at` has passed; `cosmo login` mints a
   *  fresh one. */
  | 'expired'
  /** `COSMO_BASE_URL` names a different backend than the one the stored key
   *  was issued by, so the key would only earn a 401 there. */
  | 'base_url_mismatch'
  /** Both an API key and a token were supplied. Pass one. */
  | 'conflicting_credentials'
  /** A workspace API key was passed as an end-user token. The backend would
   *  honor it as a bearer, which is how a key ends up shipped to end users. */
  | 'api_key_in_token_slot'
  /** The credential cannot go in an `Authorization` header even after
   *  surrounding whitespace and a byte-order mark are trimmed: it is empty,
   *  or it carries a character the header cannot encode. */
  | 'malformed_credential'
  /** The base URL is plain `http` to a non-loopback host. A bearer credential
   *  must not travel over cleartext. */
  | 'insecure_base_url';

/** The client has no usable credential.
 *
 *  Covers resolving one from the environment or the `cosmo login` credentials
 *  file, and refusing one supplied in a way that would leak it or fail on
 *  arrival. Always before a request carries the credential, but not always at
 *  the same call: the resolution codes surface from the first call that needs
 *  a credential, since a zero-argument client resolves asynchronously, and
 *  `insecure_base_url` is thrown where the base URL is about to be used —
 *  session start and `TokenSource.endpoint`.
 *  `code` names which — switch on it rather than matching the message. */
export class CredentialsError extends RealtimeError {
  /** Always `'CredentialsError'`. */
  readonly name = 'CredentialsError';
  /** Why the credential is unusable. A closed set this SDK throws — switch
   *  on it. */
  readonly code: CredentialsErrorCode;

  constructor(options: { code: CredentialsErrorCode; message: string }) {
    super(options.message);
    this.code = options.code;
  }
}

/** How far a `mintToken()` call got before it failed.
 *
 *  Closed: every one is raised by this SDK, so it changes only when the SDK
 *  does. It says what happened to the request, never why the server refused —
 *  that is the server's own slug, an open set, on `serverCode`. */
export type MintTokenErrorCode =
  | 'request_failed'
  | 'invalid_response'
  | 'request_rejected'
  | 'missing_api_key';

/** `mintToken()` failed.
 *
 *  `code` names what this SDK saw — match on it rather than on the message,
 *  which is written for a human. When it is `request_rejected` the server
 *  declined the request and `serverCode` carries the server's own slug, an
 *  open set: a typed rejection such as `workspace_forbidden`, or a synthetic
 *  `http_<status>` when the response carried none. */
export class MintTokenError extends ApiError {
  /** Always ``'MintTokenError'``. */
  readonly name = 'MintTokenError';
  /** How far the attempt got. A closed set this SDK raises — switch on it. */
  readonly code: MintTokenErrorCode;
  /** The server's own rejection slug when it sent one, or a synthetic
   *  ``http_<status>``. An open set: log it, do not switch on it. */
  readonly serverCode?: string;

  constructor(options: {
    code: MintTokenErrorCode;
    message: string;
    serverCode?: string;
  }) {
    super(options.message);
    this.code = options.code;
    this.serverCode = options.serverCode;
  }
}

/** The mint request's own deadline. Matches the cross-SDK contract
 *  (``mint-vectors.json``); without it a hung POST never settles. */
const MINT_TIMEOUT_MS = 45_000;

/** Full date, ``T``, full time, and an offset — the timestamp grammar every
 *  SDK enforces (``mint-vectors.json``). */
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** The expiry a ``{jwt, expires_at}`` body carries, or ``null`` when it is
 *  not a timestamp all three SDKs read the same way.
 *
 *  ``new Date`` alone is far looser than the other two: it takes a bare
 *  ``2026-01-01``, and it reads an offsetless ``2026-01-01T00:00:00`` as
 *  *local* time — so the same body would yield an expiry hours away from
 *  the one Python and Swift compute. Shared with the token endpoint, whose
 *  bodies have the same shape. */
export function parseRfc3339(raw: unknown): Date | null {
  if (typeof raw !== 'string' || !RFC3339.test(raw)) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export type PostMintTokenArgs = {
  mintUrl: string;
  externalUserId: string;
  ttlSeconds?: number;
  getAuthHeaders: () => Record<string, string> | Promise<Record<string, string>>;
};

/** Place the authenticated mint POST. Server rejections raise
 *  :class:`MintTokenError` carrying the server slug; a network failure
 *  raises ``request_failed`` and a malformed success raises
 *  ``invalid_response``. */
export async function postMintToken(args: PostMintTokenArgs): Promise<MintedToken> {
  const headers: Record<string, string> = {
    ...(await args.getAuthHeaders()),
    'Content-Type': 'application/json',
  };
  let response: Response;
  try {
    response = await fetch(args.mintUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        external_user_id: args.externalUserId,
        ...(args.ttlSeconds !== undefined ? { ttl_seconds: args.ttlSeconds } : {}),
      }),
      // ``redirect: 'error'``: the workspace api key rides on this request,
      // so a followed 30x could hand it to another origin.
      redirect: 'error',
      signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
    });
  } catch (err) {
    throw new MintTokenError({
      code: 'request_failed',
      message: describeFetchFailure(args.mintUrl, err),
    });
  }
  if (!response.ok) {
    const { code, message } = await parseErrorDetail(response);
    log.warn('[realtime] mint_token rejected', { status: response.status, code });
    throw new MintTokenError({
      code: 'request_rejected',
      message,
      serverCode: code,
    });
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new MintTokenError({ code: 'invalid_response', message: err instanceof Error ? err.message : 'Mint-token response was not JSON.' });
  }
  const minted = extractMintedToken(body);
  if (minted === null) {
    throw new MintTokenError({ code: 'invalid_response', message: 'Mint-token response missing jwt / expires_at.' });
  }
  return minted;
}

function extractMintedToken(body: unknown): MintedToken | null {
  if (typeof body !== 'object' || body === null) return null;
  const obj = body as Record<string, unknown>;
  const jwt = obj.jwt;
  if (typeof jwt !== 'string' || jwt.length === 0) return null;
  const expiresAt = parseRfc3339(obj.expires_at);
  if (expiresAt === null) return null;
  const tokenId = obj.token_id;
  return typeof tokenId === 'string' && tokenId.length > 0
    ? { jwt, expiresAt, tokenId }
    : { jwt, expiresAt };
}
