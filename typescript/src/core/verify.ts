/**
 * Credential preflight REST unit (``GET realtime/verify``).
 *
 * Mirrors the Python SDK's ``CosmoRealtime.verify``: a free check that the
 * configured credential authenticates against this backend, and that voice
 * can run here at all, without opening a billable session. Kept free of the
 * ``livekit-client`` dependency (like ``auth.ts`` and ``transport/dial.ts``).
 */

import { parseErrorDetail } from '../transport/error_detail';

/** Which of the two realtime credentials the server saw. Open-ended — treat
 *  an unknown value defensively. */
export type CredentialKind = 'api_key' | 'user_token' | (string & {});

/** The workspace a credential is bound to. */
export type VerifyWorkspace = {
  name: string;
  slug: string;
};

/** What ``verify()`` learned about the configured credential. Resolving at
 *  all means the credential authenticated against this backend; the fields
 *  say what it can do from here. */
export type CredentialInfo = {
  credential: CredentialKind;
  /** The workspace the credential is bound to. Present for an API key, which
   *  the workspace's own developer holds; null for a minted token, which is
   *  held by an end user. */
  workspace: VerifyWorkspace | null;
  scopes: string[];
  /** Whether the credential carries the scope a session start needs. False
   *  means valid but under-scoped. */
  canStartSessions: boolean;
  /** Whether this deployment is configured to run realtime voice. False
   *  means session starts here fail regardless of the credential. */
  realtimeVoiceAvailable: boolean;
  /** The end user a minted token is bound to; null for an API key. */
  externalUserId: string | null;
};

/** ``code`` carried on :class:`VerifyError`. The server's slug when
 *  the rejection carried one, or a client-side synthetic
 *  (``transport_error``, ``invalid_response``). Open-ended — treat unknown
 *  codes defensively. */
export type VerifyErrorCode = string;

/** ``verify()`` failed. An invalid credential surfaces here; a valid one that
 *  simply cannot start sessions does not — that is a field on the resolved
 *  :type:`CredentialInfo`. */
export class VerifyError extends Error {
  readonly name = 'VerifyError';
  readonly code: VerifyErrorCode;

  constructor(code: VerifyErrorCode, message: string) {
    super(message || code);
    this.code = code;
  }
}

export type GetVerifyArgs = {
  verifyUrl: string;
  getAuthHeaders: () => Record<string, string> | Promise<Record<string, string>>;
};

/** Place the authenticated preflight GET. Server rejections raise
 *  :class:`VerifyError` carrying the server slug; a network failure
 *  raises ``transport_error`` and a malformed success raises
 *  ``invalid_response``. */
export async function getVerify(args: GetVerifyArgs): Promise<CredentialInfo> {
  let response: Response;
  try {
    response = await fetch(args.verifyUrl, {
      method: 'GET',
      headers: await args.getAuthHeaders(),
    });
  } catch (err) {
    throw new VerifyError(
      'transport_error',
      err instanceof Error ? err.message : 'Verify request failed to send.',
    );
  }
  if (!response.ok) {
    const { code, message } = await parseErrorDetail(response);
    console.warn('[realtime] verify rejected', { status: response.status, code });
    throw new VerifyError(code, message);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new VerifyError(
      'invalid_response',
      err instanceof Error ? err.message : 'Verify response was not JSON.',
    );
  }
  const info = extractCredentialInfo(body);
  if (info === null) {
    throw new VerifyError('invalid_response', 'Verify response had an unexpected shape.');
  }
  return info;
}

function extractCredentialInfo(body: unknown): CredentialInfo | null {
  if (typeof body !== 'object' || body === null) return null;
  const obj = body as Record<string, unknown>;
  if (typeof obj.credential !== 'string') return null;
  const workspace = obj.workspace;
  let ws: VerifyWorkspace | null = null;
  if (workspace !== null && workspace !== undefined) {
    if (typeof workspace !== 'object') return null;
    const raw = workspace as Record<string, unknown>;
    if (typeof raw.name !== 'string' || typeof raw.slug !== 'string') return null;
    ws = { name: raw.name, slug: raw.slug };
  }
  if (!Array.isArray(obj.scopes) || obj.scopes.some((s) => typeof s !== 'string')) return null;
  if (typeof obj.can_start_sessions !== 'boolean') return null;
  if (typeof obj.realtime_voice_available !== 'boolean') return null;
  const externalUserId = obj.external_user_id;
  if (externalUserId !== null && externalUserId !== undefined && typeof externalUserId !== 'string')
    return null;
  return {
    credential: obj.credential,
    workspace: ws,
    scopes: obj.scopes as string[],
    canStartSessions: obj.can_start_sessions,
    realtimeVoiceAvailable: obj.realtime_voice_available,
    externalUserId: externalUserId ?? null,
  };
}
