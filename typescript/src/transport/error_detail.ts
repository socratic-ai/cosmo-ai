/**
 * Shared ``(code, message)`` extraction for non-OK Cosmo API responses.
 *
 * Handles both envelopes the backend emits. The external API (the surface the
 * SDK talks to) wraps every error as ``{ error: { type, message } }`` where
 * ``message`` is the endpoint's detail — a ``{ code, message }`` object for a
 * typed rejection, or a plain string (auth / validation) for which ``type``
 * is the closest thing to a slug. The internal ``{ detail: … }`` shape is
 * still read so the parser works against either surface. Falls back to a
 * synthetic ``http_<status>`` code. Used by the dial and mint-token REST
 * units; mirrors the Python SDK's ``_parse_error_detail``.
 */
export async function parseErrorDetail(
  response: Response,
): Promise<{ code: string; message: string }> {
  const fallbackCode = `http_${response.status}`;
  let text = '';
  let payload: unknown;
  try {
    text = await response.text();
    payload = JSON.parse(text);
  } catch {
    return { code: fallbackCode, message: text.slice(0, 500) };
  }
  if (typeof payload !== 'object' || payload === null) {
    return { code: fallbackCode, message: text.slice(0, 500) };
  }
  const obj = payload as Record<string, unknown>;

  const error = obj.error;
  if (typeof error === 'object' && error !== null) {
    const e = error as Record<string, unknown>;
    // A typed slug directly on the envelope wins over its ``type`` —
    // mirrors the Python parser's precedence (flattened envelope first,
    // nested ``message.{code}`` as the legacy shape).
    if (typeof e.code === 'string' && e.code && typeof e.message === 'string') {
      return { code: e.code, message: e.message };
    }
    const type = typeof e.type === 'string' && e.type ? e.type : fallbackCode;
    const detailMessage = e.message;
    if (
      typeof detailMessage === 'object' &&
      detailMessage !== null &&
      'code' in detailMessage
    ) {
      const typed = detailMessage as Record<string, unknown>;
      return { code: String(typed.code), message: stringField(typed.message) };
    }
    if (typeof detailMessage === 'string') {
      return { code: type, message: detailMessage };
    }
    return { code: type, message: text.slice(0, 500) };
  }

  const detail = obj.detail;
  if (typeof detail === 'object' && detail !== null && 'code' in detail) {
    const typed = detail as Record<string, unknown>;
    return { code: String(typed.code), message: stringField(typed.message) };
  }
  if (typeof detail === 'string') {
    return { code: fallbackCode, message: detail };
  }
  return { code: fallbackCode, message: text.slice(0, 500) };
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}
