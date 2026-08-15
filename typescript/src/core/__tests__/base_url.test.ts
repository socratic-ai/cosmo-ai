/** Backend resolution: ``COSMO_BASE_URL`` on Node, the ``<meta>`` tag a
 *  Cosmo-served page carries in a browser, production otherwise. Counterpart
 *  to the Python SDK's ``tests/test_mint.py`` base-URL cases. */

import { afterEach, describe, expect, it } from 'vitest';

import { COSMO_BASE_URL_META_NAME, DEFAULT_BASE_URL, resolveBaseUrl } from '../base_url';
import { RealtimeClient } from '../realtime_client';

type Globals = { window?: unknown; document?: unknown };

/** Replace the ambient Node environment with a browser-shaped one: a page
 *  origin, and either no ``<meta>`` tag (third-party embed) or one with the
 *  given content. ``vitest.setup.ts`` pins ``COSMO_BASE_URL``, so a browser
 *  case has to clear it — a real browser has no process environment. */
function stubBrowser(origin: string, metaContent: string | null): void {
  delete process.env.COSMO_BASE_URL;
  const globals = globalThis as Globals;
  globals.window = { location: { origin } };
  globals.document = {
    querySelector: (selector: string) => {
      if (metaContent === null) return null;
      if (selector !== `meta[name="${COSMO_BASE_URL_META_NAME}"]`) return null;
      return { getAttribute: (name: string) => (name === 'content' ? metaContent : null) };
    },
  };
}

afterEach(() => {
  const globals = globalThis as Globals;
  delete globals.window;
  delete globals.document;
  process.env.COSMO_BASE_URL = 'https://api.example.com';
});

describe('resolveBaseUrl', () => {
  it('reads COSMO_BASE_URL from the process environment', () => {
    process.env.COSMO_BASE_URL = 'https://staging.example.com';
    expect(resolveBaseUrl()).toBe('https://staging.example.com');
  });

  it('falls back to production off Node with nothing configured', () => {
    delete process.env.COSMO_BASE_URL;
    expect(resolveBaseUrl()).toBe(DEFAULT_BASE_URL);
  });

  it('treats a whitespace-only env var as unset', () => {
    process.env.COSMO_BASE_URL = '   ';
    expect(resolveBaseUrl()).toBe(DEFAULT_BASE_URL);
  });

  it('uses the page origin when a Cosmo-served page carries an empty tag', () => {
    stubBrowser('https://platform.askcosmo.ai', '');
    expect(resolveBaseUrl()).toBe('https://platform.askcosmo.ai');
  });

  it('uses the tag content over the page origin when the tag names a backend', () => {
    stubBrowser('https://platform.askcosmo.ai', 'https://realtime.example.com');
    expect(resolveBaseUrl()).toBe('https://realtime.example.com');
  });

  it('gives a third-party page with no tag production, not its own origin', () => {
    stubBrowser('https://customer-app.example.com', null);
    expect(resolveBaseUrl()).toBe(DEFAULT_BASE_URL);
  });

  it('rejects a plaintext remote backend from either source', () => {
    process.env.COSMO_BASE_URL = 'http://evil.example.com';
    expect(() => resolveBaseUrl()).toThrow(/https/);

    stubBrowser('https://platform.askcosmo.ai', 'http://evil.example.com');
    expect(() => resolveBaseUrl()).toThrow(/https/);
  });

  it('allows a plaintext localhost backend', () => {
    process.env.COSMO_BASE_URL = 'http://localhost:8000';
    expect(resolveBaseUrl()).toBe('http://localhost:8000');

    process.env.COSMO_BASE_URL = 'http://127.0.0.1:8000';
    expect(resolveBaseUrl()).toBe('http://127.0.0.1:8000');
  });

  it('rejects a relative base url — the meta tag must name an origin', () => {
    stubBrowser('https://platform.askcosmo.ai', '/api');
    expect(() => resolveBaseUrl()).toThrow(/absolute origin/);
  });

  it('rejects a cleartext page origin, so an empty tag cannot downgrade the credential', () => {
    stubBrowser('http://example.com', '');
    expect(() => resolveBaseUrl()).toThrow(/https/);
  });

  it('allows a cleartext localhost page origin, so local dev works', () => {
    stubBrowser('http://localhost:3000', '');
    expect(resolveBaseUrl()).toBe('http://localhost:3000');
  });

  it('rejects an opaque page origin rather than composing a relative URL', () => {
    // A sandboxed iframe or file:// page reports the *string* "null", which is
    // truthy — it must not survive as a base URL.
    stubBrowser('null', '');
    expect(() => resolveBaseUrl()).toThrow(/absolute origin/);
  });

  it('drops trailing slashes so one backend has one spelling', () => {
    process.env.COSMO_BASE_URL = 'https://api.example.com///';
    expect(resolveBaseUrl()).toBe('https://api.example.com');

    stubBrowser('https://platform.askcosmo.ai', 'https://realtime.example.com/');
    expect(resolveBaseUrl()).toBe('https://realtime.example.com');
  });
});

describe('RealtimeClient backend resolution', () => {
  it('resolves at construction, so a bad backend throws before any request', () => {
    process.env.COSMO_BASE_URL = 'http://evil.example.com';
    expect(() => new RealtimeClient({ apiKey: 'sk' })).toThrow(/https/);
  });

  it('exposes the resolved origin every external URL is composed from', () => {
    process.env.COSMO_BASE_URL = 'https://staging.example.com/';
    expect(new RealtimeClient({ apiKey: 'sk' }).baseUrl).toBe('https://staging.example.com');
  });
});
