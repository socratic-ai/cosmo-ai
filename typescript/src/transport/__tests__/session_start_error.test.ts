/**
 * The session/start endpoint fails closed with a structured ``detail``
 * (``minute_limit_exceeded``, ``workflow_not_ready``, …). The transport
 * must surface that detail on the thrown error so callers can show the
 * real reason instead of a generic "Failed to start the session" toast.
 */
import { describe, expect, it } from 'vitest';

import {
  SessionBusyError,
  SessionConfigError,
  SessionEntitlementError,
  SessionStartError,
  VersionMismatchError,
  parseRetryAfter,
  parseSessionStartErrorDetail,
  sessionStartErrorFrom,
} from '../session_start_error';

function jsonResponse(body: unknown): Response {
  return { json: async () => body } as unknown as Response;
}

function nonJsonResponse(): Response {
  return {
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON');
    },
  } as unknown as Response;
}

describe('parseSessionStartErrorDetail', () => {
  // The external endpoint's real envelopes: a typed HTTPException lifts
  // {code, message} onto ``error``; an AppException spreads its structured
  // details there; validation and auth rejections carry only type + message.
  it('reads a typed rejection off the external envelope (422 invalid_tool_config)', async () => {
    const res = jsonResponse({
      error: {
        type: 'api_error',
        code: 'invalid_tool_config',
        message:
          "Invalid tool configuration: 'lookup order': tool name must be snake_case",
      },
    });
    expect(await parseSessionStartErrorDetail(res)).toEqual({
      code: 'invalid_tool_config',
      message:
        "Invalid tool configuration: 'lookup order': tool name must be snake_case",
    });
  });

  it('carries the structured extras of an envelope rejection (402 free_minutes_exhausted)', async () => {
    const res = jsonResponse({
      error: {
        type: 'api_error',
        message: 'Free voice minutes are exhausted for this organization.',
        code: 'free_minutes_exhausted',
        granted_minutes: 40,
        used_minutes: 40,
      },
    });
    expect(await parseSessionStartErrorDetail(res)).toEqual({
      code: 'free_minutes_exhausted',
      message: 'Free voice minutes are exhausted for this organization.',
      granted_minutes: 40,
      used_minutes: 40,
    });
  });

  it('reads version_mismatch off the external envelope (400)', async () => {
    const res = jsonResponse({
      error: {
        type: 'api_error',
        code: 'version_mismatch',
        message:
          "Realtime wire protocol version mismatch: client speaks '2.0', server speaks '1.0'. Upgrade the Cosmo realtime SDK.",
      },
    });
    const detail = await parseSessionStartErrorDetail(res);
    expect(detail?.code).toBe('version_mismatch');
    expect(detail?.message).toContain('protocol version mismatch');
  });

  it('falls back to the envelope type when the rejection carries no code', async () => {
    const res = jsonResponse({
      error: {
        type: 'validation_error',
        message:
          'Invalid request parameters — agent.inline.audio: Extra inputs are not permitted',
        errors: [
          {
            loc: ['body', 'agent', 'inline', 'audio'],
            type: 'extra_forbidden',
            msg: 'Extra inputs are not permitted',
          },
        ],
      },
    });
    expect(await parseSessionStartErrorDetail(res)).toEqual({
      code: 'validation_error',
      message:
        'Invalid request parameters — agent.inline.audio: Extra inputs are not permitted',
    });
  });

  it('reads the legacy envelope that nests {code, message} inside message', async () => {
    const res = jsonResponse({
      error: {
        type: 'api_error',
        message: { code: 'model_unavailable', message: 'Unknown model id.' },
      },
    });
    expect(await parseSessionStartErrorDetail(res)).toEqual({
      code: 'model_unavailable',
      message: 'Unknown model id.',
    });
  });

  it('returns the structured detail object', async () => {
    const res = jsonResponse({
      detail: { code: 'workflow_not_ready', message: 'workflow is not ready to run (status: generating).' },
    });
    expect(await parseSessionStartErrorDetail(res)).toEqual({
      code: 'workflow_not_ready',
      message: 'workflow is not ready to run (status: generating).',
    });
  });

  it('normalizes a bare string detail to a message', async () => {
    const res = jsonResponse({ detail: 'playground_agent_id is not accessible from this workspace.' });
    expect(await parseSessionStartErrorDetail(res)).toEqual({
      message: 'playground_agent_id is not accessible from this workspace.',
    });
  });

  it('names the offending fields from a request-validation array', async () => {
    // The shape a client newer than its backend gets: pydantic's
    // ``extra="forbid"`` on a field that backend has no model for. An array
    // is also an object, so reading it as a structured detail yields no
    // ``message`` and the error degrades to a bare status code.
    const res = jsonResponse({
      detail: [
        {
          type: 'extra_forbidden',
          loc: ['body', 'agent', 'inline', 'audio'],
          msg: 'Extra inputs are not permitted',
        },
      ],
    });
    expect(await parseSessionStartErrorDetail(res)).toEqual({
      code: 'invalid_session_config',
      message:
        'Realtime session/start rejected the session config — ' +
        'agent.inline.audio: Extra inputs are not permitted',
    });
  });

  it('caps the rendered entries and counts the rest', async () => {
    const res = jsonResponse({
      detail: Array.from({ length: 7 }, (_, i) => ({
        loc: ['body', 'agent', `f${i}`],
        msg: 'nope',
      })),
    });
    const detail = await parseSessionStartErrorDetail(res);
    expect(detail?.message).toContain('agent.f4: nope');
    expect(detail?.message).not.toContain('agent.f5');
    expect(detail?.message).toContain('(+2 more)');
  });

  it('returns null for an empty validation array', async () => {
    expect(await parseSessionStartErrorDetail(jsonResponse({ detail: [] }))).toBeNull();
  });

  it('returns null when the body is not JSON', async () => {
    expect(await parseSessionStartErrorDetail(nonJsonResponse())).toBeNull();
  });
});

describe('SessionStartError', () => {
  it("uses the backend detail message as the error message and carries detail", () => {
    const err = new SessionStartError(400, 'Bad Request', {
      code: 'workflow_not_ready',
      message: 'workflow is not ready to run (status: generating).',
    });
    expect(err.message).toBe('workflow is not ready to run (status: generating).');
    expect(err.detail?.code).toBe('workflow_not_ready');
    expect(err.status).toBe(400);
  });

  it('falls back to the status line when there is no detail', () => {
    const err = new SessionStartError(502, 'Bad Gateway', null);
    expect(err.message).toBe('Realtime session/start rejected: 502 Bad Gateway');
    expect(err.detail).toBeNull();
  });
});

describe('sessionStartErrorFrom', () => {
  // The classifier is code-first: a subclass claims a specific cause, and
  // only the server's stable code proves it. A 429 or 402 whose code the
  // SDK doesn't know stays a plain SessionStartError; 400/422 fall back to
  // SessionConfigError, which claims only what the status already means.
  it('classifies concurrent_session_limit as SessionBusyError, carrying the limit extras', () => {
    const err = sessionStartErrorFrom(429, 'Too Many Requests', {
      code: 'concurrent_session_limit',
      message: 'This workspace already has 2 active sessions (limit 2).',
      limit: 2,
      active: 2,
    });
    expect(err).toBeInstanceOf(SessionBusyError);
    expect(err).toBeInstanceOf(SessionStartError);
    expect(err.name).toBe('SessionBusyError');
    expect((err as SessionBusyError).retryAfterSeconds).toBeUndefined();
    expect(err.detail?.limit).toBe(2);
    expect(err.detail?.active).toBe(2);
  });

  it('carries retryAfterSeconds when the server sent one', () => {
    const err = sessionStartErrorFrom(
      429,
      'Too Many Requests',
      { code: 'concurrent_session_limit', message: 'busy' },
      30,
    );
    expect((err as SessionBusyError).retryAfterSeconds).toBe(30);
  });

  it.each([
    ['free_minutes_exhausted', 'Free voice minutes are exhausted.'],
    ['provider_not_entitled', 'This plan does not include the model.'],
  ])('classifies a 402 %s as SessionEntitlementError', (code, message) => {
    const err = sessionStartErrorFrom(402, 'Payment Required', { code, message });
    expect(err).toBeInstanceOf(SessionEntitlementError);
    expect(err.name).toBe('SessionEntitlementError');
    expect(err.message).toBe(message);
  });

  it.each<[number, string | undefined]>([
    [422, 'invalid_tool_config'],
    [422, 'model_unavailable'],
    [422, 'instructions_too_long'],
    [400, undefined], // audio.output=false on a speech-to-speech-only model
  ])('classifies a %s %s rejection as SessionConfigError', (status, code) => {
    const err = sessionStartErrorFrom(status, 'Rejected', {
      code,
      message: 'rejected',
    });
    expect(err).toBeInstanceOf(SessionConfigError);
    expect(err.name).toBe('SessionConfigError');
  });

  it('classifies version_mismatch as VersionMismatchError, not a config error', () => {
    const err = sessionStartErrorFrom(400, 'Bad Request', {
      code: 'version_mismatch',
      message: "client speaks '2.0', server speaks '1.0'",
    });
    expect(err).toBeInstanceOf(VersionMismatchError);
    expect(err).not.toBeInstanceOf(SessionConfigError);
    expect(err.name).toBe('VersionMismatchError');
  });

  it.each([
    [401, 'Unauthorized'],
    [403, 'Forbidden'],
    [503, 'Service Unavailable'],
  ])('leaves a %s on the base SessionStartError', (status, statusText) => {
    const err = sessionStartErrorFrom(status, statusText, null);
    expect(err).toBeInstanceOf(SessionStartError);
    expect(err.name).toBe('SessionStartError');
    expect(err.status).toBe(status);
  });

  it('leaves a 429 with an unrecognized code on the base class', () => {
    // A gateway rate limit is not "another session holds the slot" —
    // without the concurrent_session_limit code, SessionBusyError's
    // documented meaning is unproven.
    const err = sessionStartErrorFrom(429, 'Too Many Requests', {
      code: 'global_rate_limited',
      message: 'Too many requests.',
    });
    expect(err).not.toBeInstanceOf(SessionBusyError);
    expect(err.name).toBe('SessionStartError');
  });

  it('leaves a 402 with an unrecognized code on the base class', () => {
    const err = sessionStartErrorFrom(402, 'Payment Required', {
      code: 'account_frozen',
      message: 'Account frozen.',
    });
    expect(err).not.toBeInstanceOf(SessionEntitlementError);
    expect(err.name).toBe('SessionStartError');
  });

  it('classifies a known config code regardless of status', () => {
    // A backend that moves invalid_tool_config to a different 4xx keeps
    // classifying — the code, not the status, carries the meaning.
    const err = sessionStartErrorFrom(400, 'Bad Request', {
      code: 'invalid_tool_config',
      message: "Invalid tool configuration: 'lookup order'",
    });
    expect(err).toBeInstanceOf(SessionConfigError);
  });
});

describe('parseRetryAfter', () => {
  it('parses delta-seconds', () => {
    expect(parseRetryAfter('30')).toBe(30);
  });

  it('clamps a negative delta to zero', () => {
    expect(parseRetryAfter('-5')).toBe(0);
  });

  it('converts an HTTP-date to seconds from now', () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    const seconds = parseRetryAfter(future);
    expect(seconds).toBeGreaterThanOrEqual(58);
    expect(seconds).toBeLessThanOrEqual(61);
  });

  it('returns undefined for an absent or unparseable value', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });
});
