/**
 * Canonical Cosmo external-API URL layout.
 *
 * The SDK composes every external URL from a single ``baseUrl`` origin
 * (e.g. ``https://platform.askcosmo.ai``) so callers configure one value
 * instead of a full per-endpoint URL. Kept free of the ``livekit-client``
 * dependency — these are plain string helpers.
 */

export const EXTERNAL_REALTIME_SESSION_PATH = '/api/v1/external/realtime/session';
export const EXTERNAL_AUTH_TOKEN_PATH = '/api/v1/external/auth/token';
export const EXTERNAL_REALTIME_VERIFY_PATH = '/api/v1/external/realtime/verify';
export const EXTERNAL_SESSIONS_PATH = '/api/v1/external/sessions';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Reject a ``baseUrl`` that would carry a credential over plaintext:
 *  ``https://`` anywhere, ``http://`` only for localhost. Throws a plain
 *  ``Error`` on a malformed or plaintext-remote origin. */
export function assertSupportedBaseUrl(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`baseUrl must be an absolute origin, got ${JSON.stringify(baseUrl)}`);
  }
  if (parsed.protocol !== 'https:' && !LOCAL_HOSTS.has(parsed.hostname)) {
    throw new Error('baseUrl must use https:// (http is allowed only for localhost)');
  }
}

/** Canonical external session-start URL composed from a ``baseUrl`` origin. */
export function composeStartUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${EXTERNAL_REALTIME_SESSION_PATH}/start`;
}

/** Canonical external dial URL composed from a ``baseUrl`` origin and the live
 *  session id. The realtime session — and so its dial endpoint — always lives
 *  on the Cosmo external API at ``baseUrl``. */
export function composeDialUrl(baseUrl: string, sessionId: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${EXTERNAL_REALTIME_SESSION_PATH}/${encodeURIComponent(sessionId)}/dial`;
}

/** Canonical usage-summary URL (``GET sessions/{id}/usage``) composed
 *  from a ``baseUrl`` origin and the session id. */
export function composeUsageUrl(baseUrl: string, sessionId: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${EXTERNAL_SESSIONS_PATH}/${encodeURIComponent(sessionId)}/usage`;
}

/** Canonical mint-token URL (``POST auth/token``) composed from a ``baseUrl``
 *  origin. */
export function composeMintTokenUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${EXTERNAL_AUTH_TOKEN_PATH}`;
}

/** Canonical credential-preflight URL (``GET realtime/verify``) composed from
 *  a ``baseUrl`` origin. */
export function composeVerifyUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${EXTERNAL_REALTIME_VERIFY_PATH}`;
}
