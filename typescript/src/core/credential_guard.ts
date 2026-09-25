/**
 * Which credential belongs in which parameter, and what shape it has to be in
 * before that question can be answered.
 *
 * ``cosmo_…`` values are self-identifying, so an API key handed to ``token``
 * is a category error the constructor can name — and one worth naming: the
 * backend honors any ``cosmo_…`` bearer, so a key in that slot works, right
 * up until the app carrying it reaches someone else.
 */

import { CredentialsError } from './auth';

const SECRET_PREFIX = 'cosmo_';
const ACTS_AS_USER_PREFIX = 'cosmo_pat_';
/** Whitespace or a byte-order mark at either end. ``\s`` already covers
 *  ``﻿`` in JavaScript; it is spelled out so the intent survives. */
const EDGE_NOISE = /^[\s﻿]+|[\s﻿]+$/g;

const END_USER_CREDENTIALS_DOCS =
  'https://platform.askcosmo.ai/docs/production/end-user-credentials';

/**
 * The credential as it can be sent, or a named error.
 *
 * A key read from a file or an environment variable arrives with whatever
 * wrote it left behind: a trailing newline from a shell redirect, a byte-order
 * mark from PowerShell's UTF-8. Those are trimmed. Anything still outside
 * printable ASCII cannot go in an ``Authorization`` header, and ``fetch``
 * throws ``TypeError: Cannot convert argument to a ByteString`` from inside
 * the request — outside the error family a caller catches. Refuse it here
 * instead, as the other unusable credentials are refused.
 *
 * Callers clean *before* {@link assertNotApiKeyInTokenSlot} reads the value:
 * a key pasted with a byte-order mark does not match the ``cosmo_`` prefix
 * until it is cleaned, so guarding first would let the exact value that guard
 * exists to refuse through, and then clean it into a working bearer.
 */
export function cleanCredential(raw: string): string {
  // Edges only, like the Python SDK's strip: a mark or a space *inside* the
  // value is a wrong credential, not a dirty one, and is named below.
  const cleaned = raw.replace(EDGE_NOISE, '');
  if (cleaned === '') {
    throw new CredentialsError({
      code: 'malformed_credential',
      message: 'The credential is empty once whitespace is trimmed.',
    });
  }
  const bad = [...cleaned].find((c) => {
    const point = c.codePointAt(0) ?? 0;
    return point < 0x21 || point > 0x7e;
  });
  if (bad !== undefined) {
    throw new CredentialsError({
      code: 'malformed_credential',
      message:
        `The credential contains ${JSON.stringify(bad)}, which an ` +
        'Authorization header cannot carry — check for a stray character ' +
        'in the value.',
    });
  }
  return cleaned;
}

/** Refuse a workspace API key passed as ``token``. Acts-as-user tokens
 *  (``cosmo_pat_…``) are a real bearer credential and pass through.
 *
 *  Expects an already-cleaned value; see {@link cleanCredential}. */
export function assertNotApiKeyInTokenSlot(token: string): void {
  if (!token.startsWith(SECRET_PREFIX) || token.startsWith(ACTS_AS_USER_PREFIX)) return;
  throw new CredentialsError({
    code: 'api_key_in_token_slot',
    message:
      'This is a workspace API key (cosmo_…), not a minted end-user token. ' +
      'Pass it as apiKey — or mint a token for this user with mintToken() ' +
      `on your server and pass that. See ${END_USER_CREDENTIALS_DOCS}`,
  });
}
