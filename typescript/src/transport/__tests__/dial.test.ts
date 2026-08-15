/**
 * Outbound dial is an authenticated REST call, so its E.164 fast-fail and error
 * decoding are pure functions that must work against both backend error
 * envelopes (the external ``{ error: … }`` wrapper and the internal
 * ``{ detail: … }`` shape). These tests pin that decoding + the E.164 check in
 * isolation, free of any transport. (URL composition lives in
 * ``external_session_url.ts`` / its test.)
 */
import { describe, expect, it } from 'vitest';

import { DialError, validateE164 } from '../dial';
import { parseErrorDetail } from '../error_detail';

function res(status: number, body: string): Response {
  return { status, text: async () => body } as unknown as Response;
}

describe('validateE164', () => {
  it('accepts a well-formed E.164 number and trims surrounding whitespace', () => {
    expect(validateE164('  +14155550199 ')).toBe('+14155550199');
  });

  it.each([
    ['missing +', '14155550199'],
    ['too short', '+1234567'],
    ['too long', '+1234567890123456'],
    ['non-digits', '+1415555O199'],
    ['plus only', '+'],
  ])('rejects %s with invalid_phone_number', (_label, input) => {
    expect(() => validateE164(input)).toThrow(DialError);
    try {
      validateE164(input);
    } catch (err) {
      expect((err as DialError).code).toBe('invalid_phone_number');
    }
  });
});

describe('parseErrorDetail', () => {
  it('reads a typed code/message from the external error envelope', async () => {
    const body = JSON.stringify({
      error: { type: 'api_error', message: { code: 'phone_calls_disabled', message: 'Phone calls are not enabled.' } },
    });
    expect(await parseErrorDetail(res(403, body))).toEqual({
      code: 'phone_calls_disabled',
      message: 'Phone calls are not enabled.',
    });
  });

  it('falls back to the error type when the external message is a plain string', async () => {
    const body = JSON.stringify({ error: { type: 'api_error', message: 'Invalid API key.' } });
    expect(await parseErrorDetail(res(401, body))).toEqual({
      code: 'api_error',
      message: 'Invalid API key.',
    });
  });

  it('reads a typed code/message from the internal detail envelope', async () => {
    const body = JSON.stringify({
      detail: { code: 'session_not_live', message: 'Session has ended.' },
    });
    expect(await parseErrorDetail(res(409, body))).toEqual({
      code: 'session_not_live',
      message: 'Session has ended.',
    });
  });

  it('normalizes a bare string internal detail to http_<status> + message', async () => {
    const body = JSON.stringify({ detail: 'session_not_found' });
    expect(await parseErrorDetail(res(404, body))).toEqual({
      code: 'http_404',
      message: 'session_not_found',
    });
  });

  it('falls back to http_<status> and the raw text for a non-JSON body', async () => {
    const result = await parseErrorDetail(res(502, '<html>bad gateway</html>'));
    expect(result.code).toBe('http_502');
    expect(result.message).toBe('<html>bad gateway</html>');
  });
});

describe('DialError', () => {
  it('carries the slug as code and the reason as message', () => {
    const err = new DialError('minute_limit_exceeded', 'Weekly limit reached.');
    expect(err.code).toBe('minute_limit_exceeded');
    expect(err.message).toBe('Weekly limit reached.');
    expect(err.name).toBe('DialError');
  });

  it('falls back to the code as the error message when no reason is given', () => {
    expect(new DialError('not_dialable', '').message).toBe('not_dialable');
  });
});
