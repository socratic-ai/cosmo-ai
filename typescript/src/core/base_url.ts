/**
 * Where the SDK finds the Cosmo backend.
 *
 * One name — ``COSMO_BASE_URL`` — in every runtime; only the transport
 * differs. Node reads the process environment. A browser has none, so a
 * Cosmo-served page carries the value in a ``<meta>`` tag its server wrote at
 * request time.
 *
 * The tag's *presence* is what marks a page as Cosmo-served, and an empty tag
 * means "this page's own origin" — so one build serves ``app``, ``staging``,
 * a per-PR preview host and ``localhost`` with nothing configured. The origin
 * comes from ``window.location``, never from a request header: this value
 * decides where the page sends its credential, and ``Host`` is caller-
 * controllable where ``window.location.origin`` is not.
 *
 * A page with no tag is a third-party embed and gets production.
 */

import { assertSupportedBaseUrl } from '../transport/external_session_url';
import { pageOrigin } from './page_origin';

export const COSMO_BASE_URL_META_NAME = 'cosmo-base-url';
export const DEFAULT_BASE_URL = 'https://platform.askcosmo.ai';

/** ``COSMO_BASE_URL`` from the process environment, or null off Node.
 *
 * The ``typeof`` guard is load-bearing: bundlers that don't shim ``process``
 * (Vite, webpack 5) leave it undefined in a browser, where a bare reference
 * is a ReferenceError rather than ``undefined``. */
function envBaseUrl(): string | null {
  if (typeof process === 'undefined') return null;
  return process.env?.COSMO_BASE_URL?.trim() || null;
}

/** What the page's ``<meta>`` tag says, distinguishing "no tag" (third-party
 *  embed) from "tag with no value" (Cosmo-served, use this page's origin). */
function metaDirective(): { present: false } | { present: true; value: string } {
  if (typeof document === 'undefined') return { present: false };
  const tag = document.querySelector(`meta[name="${COSMO_BASE_URL_META_NAME}"]`);
  if (tag === null) return { present: false };
  return { present: true, value: (tag.getAttribute('content') ?? '').trim() };
}

/** Which backend this runtime names, before it is checked. */
function selectBaseUrl(): string {
  const env = envBaseUrl();
  if (env !== null) return env;

  const meta = metaDirective();
  if (meta.present) {
    if (meta.value !== '') return meta.value;
    // A sandboxed iframe or file:// page reports the *string* "null", which is
    // truthy — it reaches the check below rather than passing as an origin.
    const origin = pageOrigin();
    if (origin !== null) return origin;
  }

  return DEFAULT_BASE_URL;
}

/**
 * The API origin every Cosmo REST call composes from.
 *
 * Called once when a client is constructed, so a misconfigured backend throws
 * there rather than at the first request — matching the Python SDK, and Swift,
 * which resolves when the session starts.
 *
 * Every source is checked on the way out rather than in its own branch, so no
 * future source can be added without the guarantee. Trailing slashes are
 * dropped so one backend has one spelling across all three SDKs.
 */
export function resolveBaseUrl(): string {
  const selected = selectBaseUrl();
  assertSupportedBaseUrl(selected);
  return selected.replace(/\/+$/, '');
}
