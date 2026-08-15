import { log } from '../core/logger';
/**
 * Error model for a rejected ``/realtime/session/start``.
 *
 * Kept free of the ``livekit-client`` dependency that ``livekit_transport``
 * pulls in so the backend's structured ``detail`` (``concurrent_session_limit``,
 * ``model_unavailable``, …) can be parsed and asserted in isolation.
 */

/** Structured ``detail`` the backend returns on a rejected session/start.
 *  Carried on ``SessionStartError`` so callers can show the real
 *  reason instead of a generic failure. Typed rejections carry extras
 *  beyond these: a concurrent-session rejection adds ``limit`` and
 *  ``active``, an exhausted free tier adds ``granted_minutes`` and
 *  ``used_minutes``. */
export type RealtimeSessionStartDetail = {
  code?: string;
  message?: string;
  limit?: number;
  active?: number;
  granted_minutes?: number;
  used_minutes?: number;
};

export class SessionStartError extends Error {
  readonly status: number;
  readonly detail: RealtimeSessionStartDetail | null;

  constructor(
    status: number,
    statusText: string,
    detail: RealtimeSessionStartDetail | null,
  ) {
    super(
      detail?.message ??
        `Realtime session/start rejected: ${status} ${statusText}`,
    );
    this.name = 'SessionStartError';
    this.status = status;
    this.detail = detail;
  }
}

/** The workspace is at its concurrent-session limit
 *  (429 ``concurrent_session_limit``). The common cause
 *  is an abandoned session: closing or reloading a page mid-session leaves
 *  the old session holding a slot until the server notices the empty room
 *  and reclaims it after a short window — retrying shortly after succeeds.
 *  Ending sessions cleanly (``session.end()``) frees the slot immediately.
 *  ``retryAfterSeconds`` is set when the server sends a ``Retry-After``. */
export class SessionBusyError extends SessionStartError {
  readonly retryAfterSeconds?: number;

  constructor(
    status: number,
    statusText: string,
    detail: RealtimeSessionStartDetail | null,
    retryAfterSeconds?: number,
  ) {
    super(status, statusText, detail);
    this.name = 'SessionBusyError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** The plan refused the session (402): the free voice grant is spent
 *  (``free_minutes_exhausted``) or the model's provider is not included in
 *  the workspace's plan (``provider_not_entitled``). Not retryable — the
 *  workspace needs a payment method or a plan change. */
export class SessionEntitlementError extends SessionStartError {
  constructor(
    status: number,
    statusText: string,
    detail: RealtimeSessionStartDetail | null,
  ) {
    super(status, statusText, detail);
    this.name = 'SessionEntitlementError';
  }
}

/** The server rejected the session config (400/422): an unknown model id, a
 *  bad tool spec, oversize instructions, an unresolvable catalog agent, or a
 *  body the schema refused. ``detail.code`` names the specific rejection;
 *  the message says what to fix. Retrying the same config fails the same
 *  way. */
export class SessionConfigError extends SessionStartError {
  constructor(
    status: number,
    statusText: string,
    detail: RealtimeSessionStartDetail | null,
  ) {
    super(status, statusText, detail);
    this.name = 'SessionConfigError';
  }
}

/** The client's wire-protocol version is incompatible with the server
 *  (``version_mismatch``). Upgrade the SDK. Mirrors Python's
 *  ``VersionMismatchError``. */
export class VersionMismatchError extends SessionStartError {
  constructor(
    status: number,
    statusText: string,
    detail: RealtimeSessionStartDetail | null,
  ) {
    super(status, statusText, detail);
    this.name = 'VersionMismatchError';
  }
}

const ENTITLEMENT_CODES = new Set(['free_minutes_exhausted', 'provider_not_entitled']);

const CONFIG_CODES = new Set([
  'model_unavailable',
  'invalid_tool_config',
  'instructions_too_long',
  'turn_detection_knob_mismatch',
  'unknown_agent',
  'agent_config_unavailable',
  'greeting_too_long',
  'invalid_session_config',
  'validation_error',
]);

/** Construct the most specific :class:`SessionStartError` for a rejection.
 *
 *  Classification is by the server's stable ``code``, not the HTTP status:
 *  a subclass makes a claim about *why* the start was refused, and a status
 *  alone can't prove it — a gateway-generated 429 is not "another session
 *  holds the slot", and a future 402 meaning must not inherit today's copy.
 *  A rejection whose code the SDK doesn't know stays a plain
 *  :class:`SessionStartError`. The one status fallback is 400/422 →
 *  :class:`SessionConfigError`, which claims only what any such status
 *  already means: the request body was refused. */
export function sessionStartErrorFrom(
  status: number,
  statusText: string,
  detail: RealtimeSessionStartDetail | null,
  retryAfterSeconds?: number,
): SessionStartError {
  const code = detail?.code;
  if (code === 'version_mismatch') {
    return new VersionMismatchError(status, statusText, detail);
  }
  if (code === 'concurrent_session_limit') {
    return new SessionBusyError(status, statusText, detail, retryAfterSeconds);
  }
  if (code !== undefined && ENTITLEMENT_CODES.has(code)) {
    return new SessionEntitlementError(status, statusText, detail);
  }
  if (
    (code !== undefined && CONFIG_CODES.has(code)) ||
    status === 400 ||
    status === 422
  ) {
    return new SessionConfigError(status, statusText, detail);
  }
  return new SessionStartError(status, statusText, detail);
}

/** Parse a ``Retry-After`` value — delta-seconds or an HTTP-date — into
 *  seconds from now. Undefined when the header is absent or unparseable. */
export function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || value === '') return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.round((date - Date.now()) / 1000));
}

/** ``session/start`` never reached the server — DNS, TLS, offline, or a
 *  refused CORS preflight. Deliberately NOT a
 *  :class:`SessionStartError`: that type means the server answered and
 *  rejected, and callers branch on it to report a handshake failure rather
 *  than a transport one. ``code`` is always ``transport_error``. */
export class SessionStartTransportError extends Error {
  readonly name = 'SessionStartTransportError';
  readonly code = 'transport_error';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** One entry of FastAPI's request-validation ``detail`` array. */
type ValidationErrorEntry = { loc?: unknown[]; msg?: string };

/** Cap on rendered validation entries — a rejected config can produce one per
 *  field, and the message is for a human reading a console. */
const MAX_RENDERED_VALIDATION_ERRORS = 5;

/** Render FastAPI's validation-error array as one line naming the fields that
 *  failed. Without this a schema rejection reaches the caller as a bare status
 *  code, which is indistinguishable from any other 422 — the field path is the
 *  whole diagnosis, most often a client newer than the backend it is talking
 *  to sending a field that backend has no model for. */
function formatValidationErrors(
  entries: ValidationErrorEntry[],
): RealtimeSessionStartDetail {
  const rendered = entries
    .slice(0, MAX_RENDERED_VALIDATION_ERRORS)
    .map((entry) => {
      // ``loc`` is prefixed with the source of the value ("body"), which says
      // nothing here — every session-config rejection is about the body.
      const loc = (entry.loc ?? []).filter(
        (part, index) => !(index === 0 && part === 'body'),
      );
      const path = loc.join('.');
      const msg = entry.msg ?? 'is invalid';
      return path ? `${path}: ${msg}` : msg;
    });
  const omitted = entries.length - rendered.length;
  if (omitted > 0) rendered.push(`(+${omitted} more)`);
  return {
    code: 'invalid_session_config',
    message: `Realtime session/start rejected the session config — ${rendered.join('; ')}`,
  };
}

/** Detail carried in the external ``{ error: {...} }`` envelope the
 *  session-start endpoint returns. A typed rejection has its ``code`` lifted
 *  onto the envelope alongside ``message`` (plus structured extras such as
 *  ``limit`` / ``active``); an untyped one carries only ``type`` + ``message``, so
 *  ``type`` (``api_error`` / ``validation_error``) is the closest thing to a
 *  code. Mirrors ``parseErrorDetail``'s precedence, including the legacy
 *  shape that nested ``{code, message}`` inside ``message``. */
function envelopeDetail(error: unknown): RealtimeSessionStartDetail | null {
  if (typeof error !== 'object' || error === null || Array.isArray(error)) {
    return null;
  }
  const { type, ...detail } = error as { type?: unknown } & Record<
    string,
    unknown
  >;
  if (
    typeof detail.code === 'string' &&
    detail.code &&
    typeof detail.message === 'string'
  ) {
    return detail as RealtimeSessionStartDetail;
  }
  const message = detail.message;
  if (typeof message === 'object' && message !== null && 'code' in message) {
    return message as RealtimeSessionStartDetail;
  }
  if (typeof message === 'string') {
    return typeof type === 'string' && type
      ? { code: type, message }
      : { message };
  }
  return null;
}

/** Pull the backend's error body off a non-OK session/start response.
 *  The external endpoint wraps every error as ``{ error: {...} }`` (see
 *  ``envelopeDetail``). The internal ``{ detail }`` shape is still read for
 *  skew against older backends: an object detail for structured errors, an
 *  array of ``{loc, msg}`` entries for request-validation failures, and a
 *  bare string for plain ones. All are normalized to
 *  ``RealtimeSessionStartDetail``. Returns null when the body isn't JSON
 *  (network error, proxy 5xx). */
export async function parseSessionStartErrorDetail(
  response: Response,
): Promise<RealtimeSessionStartDetail | null> {
  try {
    const data = (await response.json()) as {
      error?: unknown;
      detail?: unknown;
    };
    const envelope = envelopeDetail(data?.error);
    if (envelope) return envelope;
    const detail = data?.detail;
    // Ordered before the object branch: an array is also an object, and
    // reading one as a structured detail yields no ``message`` at all.
    if (Array.isArray(detail)) {
      return detail.length > 0
        ? formatValidationErrors(detail as ValidationErrorEntry[])
        : null;
    }
    if (detail && typeof detail === 'object') {
      return detail as RealtimeSessionStartDetail;
    }
    if (typeof detail === 'string') return { message: detail };
    return null;
  } catch (err) {
    log.warn('[realtime] session/start error body was not JSON', err);
    return null;
  }
}
