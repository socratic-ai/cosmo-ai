/**
 * A workspace API key in the ``token`` slot is refused at construction. The
 * backend honors any ``cosmo_…`` bearer, so without this the mistake works —
 * which is how a key reaches an app's users.
 *
 * Also what the credential has to look like before that question can be
 * answered: a key carries whatever wrote it, and the cleaning that removes it
 * must not open the guard it sits next to.
 */

import { describe, expect, it } from 'vitest';

import { CredentialsError } from '../auth';
import { assertNotApiKeyInTokenSlot, cleanCredential } from '../credential_guard';
import { RealtimeClient } from '../realtime_client';

const KEY = `cosmo_${'a'.repeat(64)}`;
const PAT = `cosmo_pat_${'b'.repeat(32)}`;
const JWT = 'eyJhbGciOiJIUzI1NiJ9.payload.sig';
const BOM = '﻿';

describe('the token slot', () => {
  it('refuses an API key, naming the parameter that takes one', () => {
    expect(() => assertNotApiKeyInTokenSlot(KEY)).toThrowError(/apiKey|mintToken/);
  });

  it('lets minted JWTs and acts-as-user tokens through', () => {
    expect(() => assertNotApiKeyInTokenSlot(JWT)).not.toThrow();
    expect(() => assertNotApiKeyInTokenSlot(PAT)).not.toThrow();
  });

  it('refuses at construction, before any network path', () => {
    expect(() => new RealtimeClient({ token: KEY })).toThrowError(/apiKey/);
  });

  it('leaves the apiKey parameter alone — a key there is correct anywhere', () => {
    expect(() => new RealtimeClient({ apiKey: KEY })).not.toThrow();
  });

  it('still refuses a key the cleaning had to uncover', () => {
    // Guarding before cleaning would pass these: neither starts with
    // ``cosmo_`` until it is trimmed, and both are a workspace key.
    for (const raw of [BOM + KEY, `  ${KEY}\n`, `${KEY}\r\n`]) {
      let caught: unknown;
      try {
        new RealtimeClient({ token: raw });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(CredentialsError);
      expect((caught as CredentialsError).code).toBe('api_key_in_token_slot');
    }
  });
});

describe('a credential as it arrives', () => {
  it('is usable when it carries what wrote it', () => {
    // A shell redirect leaves a newline; PowerShell's UTF-8 leaves a mark.
    // Either one reaches fetch and throws a TypeError from Headers, outside
    // the error family a caller catches.
    for (const raw of [`${KEY}\n`, BOM + KEY, `  ${KEY} `, `${KEY}\r\n`]) {
      expect(cleanCredential(raw)).toBe(KEY);
    }
  });

  it('is refused, and named, when a header still cannot carry it', () => {
    // Trimming ends at the edges: a stray character inside the value is a
    // wrong credential, not a dirty one.
    for (const raw of [`cosmo_aaa\nbbb`, `cosmo_aaa${BOM}bbb`, '   ', '']) {
      let caught: unknown;
      try {
        cleanCredential(raw);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(CredentialsError);
      expect((caught as CredentialsError).code).toBe('malformed_credential');
    }
  });

  it('reaches the Authorization header clean', async () => {
    const client = new RealtimeClient({ apiKey: BOM + KEY });
    const headers = await (
      client as unknown as { resolveAuthHeaders(): Promise<Record<string, string>> }
    ).resolveAuthHeaders();
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    // The mark is what makes this more than cosmetic: Headers refuses it.
    expect(() => new Headers(headers)).not.toThrow();
  });
});
