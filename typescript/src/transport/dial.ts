/**
 * Outbound-dial REST unit for the Cosmo Realtime SDK.
 *
 * Mirrors the Python SDK's ``session.dial()``: an authenticated POST to
 * ``…/external/realtime/session/{id}/dial`` that brings a phone callee into a
 * live session's LiveKit room as a SIP participant. Kept free of the
 * ``livekit-client`` dependency (like ``session_start_error.ts``) — dialing is
 * a plain REST call, not a transport / data-channel concern. The dial URL is
 * composed by ``composeDialUrl`` in ``external_session_url.ts``.
 */

import { log } from '../core/logger';
import { parseErrorDetail } from './error_detail';
import { describeFetchFailure } from './fetch_failure';

/** Outcome of a successful ``dial()`` (``POST …/session/{id}/dial``): the dial
 *  was queued. The call rings asynchronously — observe progress via session
 *  events, not this value. ``dialId`` correlates the call server-side. */
export type DialResult = {
  dialId: string;
};

/** ``code`` carried on :class:`DialError`. The server's slug when the
 *  rejection carried one (``phone_calls_disabled``, ``minute_limit_exceeded``,
 *  ``session_not_found``, ``session_not_live``, ``session_already_dialed``) or
 *  a client-side synthetic (``invalid_phone_number``, ``transport_error``,
 *  ``invalid_response``). Slug-less auth / validation
 *  rejections surface the error ``type`` instead (e.g. ``api_error``).
 *  Open-ended — treat unknown codes defensively. */
export type DialErrorCode = string;

/** ``dial()`` failed. ``code`` is a stable slug (see :type:`DialErrorCode`);
 *  ``message`` is the human-readable reason. */
export class DialError extends Error {
  readonly name = 'DialError';
  readonly code: DialErrorCode;

  constructor(code: DialErrorCode, message: string) {
    super(message || code);
    this.code = code;
  }
}

/** Local fast-fail mirror of the server's E.164 check so an obviously
 *  malformed number throws before any round-trip. ``+`` then 8–15 digits. */
export function validateE164(phoneNumber: string): string {
  const value = phoneNumber.trim();
  const digits = value.slice(1);
  if (!value.startsWith('+') || !/^\d+$/.test(digits) || digits.length < 8 || digits.length > 15) {
    throw new DialError(
      'invalid_phone_number',
      'phone_number must be E.164, e.g. +14155550199',
    );
  }
  return value;
}

export type PostDialArgs = {
  dialUrl: string;
  phoneNumber: string;
  /** Optional E.164 caller-ID to present. Must be an ACTIVE number in the
   *  workspace pool (server rejects otherwise). Omit for the trunk default. */
  callerNumber?: string;
  getAuthHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
};

/** Place the authenticated dial POST. Server rejections raise
 *  :class:`DialError` carrying the server slug; a network failure
 *  raises ``transport_error`` and a malformed success raises
 *  ``invalid_response``. */
export async function postDial(args: PostDialArgs): Promise<DialResult> {
  const extraHeaders = args.getAuthHeaders ? await args.getAuthHeaders() : {};
  const headers: Record<string, string> = {
    ...extraHeaders,
    'Content-Type': 'application/json',
  };
  const requestBody: Record<string, string> = { phone_number: args.phoneNumber };
  if (args.callerNumber !== undefined) {
    requestBody.caller_number = args.callerNumber;
  }
  let response: Response;
  try {
    response = await fetch(args.dialUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
    });
  } catch (err) {
    throw new DialError(
      'transport_error',
      describeFetchFailure(args.dialUrl, err),
    );
  }
  if (!response.ok) {
    const { code, message } = await parseErrorDetail(response);
    log.warn('[realtime] dial rejected', { status: response.status, code });
    throw new DialError(code, message);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new DialError(
      'invalid_response',
      err instanceof Error ? err.message : 'Dial response was not JSON.',
    );
  }
  const dialId = extractDialId(body);
  if (dialId === null) {
    throw new DialError('invalid_response', 'Dial response missing dial_id.');
  }
  return { dialId };
}

function extractDialId(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const id = (body as Record<string, unknown>).dial_id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}
