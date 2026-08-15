/**
 * Credential model + mint-token REST unit for the Cosmo Realtime SDK.
 *
 * Mirrors the Python SDK's credential story: a client is constructed with an
 * **API key** (workspace-scoped, server-side only, can mint end-user tokens)
 * XOR a **user token** (a minted end-user JWT, safe on end-user devices, can
 * open sessions but cannot mint). Kept free of the ``livekit-client``
 * dependency (like ``transport/dial.ts``) — minting is a plain REST call.
 */

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
  jwt: string;
  expiresAt: Date;
  tokenId?: string;
};

/** The client's credential configuration is unusable: both ``apiKey`` and
 *  ``token`` were passed, or zero-argument resolution failed. For resolution
 *  failures ``code`` is a stable slug shared with the cross-SDK conformance
 *  vectors (``no_credential``, ``profile_not_found``, ``file_invalid``,
 *  ``expired``); construction-time misuse carries no code. */
export class CredentialError extends Error {
  readonly name = 'CredentialError';
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

/** ``code`` carried on :class:`MintTokenError`. The server's slug when
 *  the rejection carried one, or a client-side synthetic (``no_api_key``,
 *  ``transport_error``, ``invalid_response``). Slug-less auth / validation
 *  rejections surface the error ``type`` instead (e.g. ``api_error``).
 *  Open-ended — treat unknown codes defensively. */
export type MintTokenErrorCode = string;

/** ``mintToken()`` failed. ``code`` is a stable slug (see
 *  :type:`MintTokenErrorCode`); ``message`` is the human-readable reason. */
export class MintTokenError extends Error {
  readonly name = 'MintTokenError';
  readonly code: MintTokenErrorCode;

  constructor(code: MintTokenErrorCode, message: string) {
    super(message || code);
    this.code = code;
  }
}

export type PostMintTokenArgs = {
  mintUrl: string;
  externalUserId: string;
  ttlSeconds?: number;
  getAuthHeaders: () => Record<string, string> | Promise<Record<string, string>>;
};

/** Place the authenticated mint POST. Server rejections raise
 *  :class:`MintTokenError` carrying the server slug; a network failure
 *  raises ``transport_error`` and a malformed success raises
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
    });
  } catch (err) {
    throw new MintTokenError(
      'transport_error',
      describeFetchFailure(args.mintUrl, err),
    );
  }
  if (!response.ok) {
    const { code, message } = await parseErrorDetail(response);
    log.warn('[realtime] mint_token rejected', { status: response.status, code });
    throw new MintTokenError(code, message);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new MintTokenError(
      'invalid_response',
      err instanceof Error ? err.message : 'Mint-token response was not JSON.',
    );
  }
  const minted = extractMintedToken(body);
  if (minted === null) {
    throw new MintTokenError(
      'invalid_response',
      'Mint-token response missing jwt / expires_at.',
    );
  }
  return minted;
}

function extractMintedToken(body: unknown): MintedToken | null {
  if (typeof body !== 'object' || body === null) return null;
  const obj = body as Record<string, unknown>;
  const jwt = obj.jwt;
  const expiresAtRaw = obj.expires_at;
  if (typeof jwt !== 'string' || jwt.length === 0) return null;
  if (typeof expiresAtRaw !== 'string') return null;
  const expiresAt = new Date(expiresAtRaw);
  if (Number.isNaN(expiresAt.getTime())) return null;
  const tokenId = obj.token_id;
  return typeof tokenId === 'string' && tokenId.length > 0
    ? { jwt, expiresAt, tokenId }
    : { jwt, expiresAt };
}
