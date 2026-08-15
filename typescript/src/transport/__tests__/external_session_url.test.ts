import { describe, expect, it } from 'vitest';
import {
  assertSupportedBaseUrl,
  composeDialUrl,
  composeMintTokenUrl,
  composeStartUrl,
} from '../external_session_url';

describe('composeStartUrl', () => {
  it('composes the session-start URL from a baseUrl origin', () => {
    expect(composeStartUrl('https://platform.askcosmo.ai')).toBe(
      'https://platform.askcosmo.ai/api/v1/external/realtime/session/start',
    );
  });

  it('strips trailing slashes on the baseUrl origin', () => {
    expect(composeStartUrl('https://platform.askcosmo.ai/')).toBe(
      'https://platform.askcosmo.ai/api/v1/external/realtime/session/start',
    );
  });
});

describe('composeDialUrl', () => {
  it('composes the canonical external dial URL from a baseUrl origin + session id', () => {
    expect(composeDialUrl('https://platform.askcosmo.ai', 'sess-123')).toBe(
      'https://platform.askcosmo.ai/api/v1/external/realtime/session/sess-123/dial',
    );
  });

  it('strips a trailing slash on baseUrl and url-encodes the session id', () => {
    expect(composeDialUrl('https://platform.askcosmo.ai/', 'sess/odd id')).toBe(
      'https://platform.askcosmo.ai/api/v1/external/realtime/session/sess%2Fodd%20id/dial',
    );
  });
});

describe('composeMintTokenUrl', () => {
  it('composes the canonical mint-token URL and strips a trailing slash', () => {
    expect(composeMintTokenUrl('https://platform.askcosmo.ai/')).toBe(
      'https://platform.askcosmo.ai/api/v1/external/auth/token',
    );
  });
});

describe('assertSupportedBaseUrl', () => {
  it.each([
    ['https anywhere', 'https://platform.askcosmo.ai'],
    ['http on localhost', 'http://localhost:8000'],
    ['http on 127.0.0.1', 'http://127.0.0.1:8000'],
    ['http on [::1]', 'http://[::1]:8000'],
  ])('allows %s', (_label, url) => {
    expect(() => assertSupportedBaseUrl(url)).not.toThrow();
  });

  it('rejects plaintext http for a remote host', () => {
    expect(() => assertSupportedBaseUrl('http://evil.example.com')).toThrow(/https/);
  });

  it('rejects a relative or malformed baseUrl', () => {
    expect(() => assertSupportedBaseUrl('/api')).toThrow(/absolute origin/);
  });
});
