/**
 * Shared diagnosis for a Cosmo REST call that never reached the server.
 *
 * A browser reports every pre-response failure — DNS, TLS, offline, a refused
 * CORS preflight — as the same bare ``TypeError: Failed to fetch``, with the
 * real reason visible only in devtools. Cross-origin is the one cause the SDK
 * can recognize on its own, by comparing the request's origin against the
 * page's, so it names that possibility instead of re-throwing the bare error.
 */

import { pageOrigin } from '../core/page_origin';

/** The origin of ``url``, or null when it isn't absolute. */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Explain a failed ``fetch`` to ``url``, naming a cross-origin request as the
 *  likely cause when the page and the target differ. */
export function describeFetchFailure(url: string, err: unknown): string {
  const reason = err instanceof Error ? err.message : String(err);
  const page = pageOrigin();
  const target = originOf(url);
  // A sandboxed iframe reports the opaque origin as the string "null", which
  // names nothing useful to a reader.
  if (page === null || page === 'null' || target === null || page === target) return reason;
  return (
    `${reason} — the request to ${target} never reached the server. ` +
    `This page is served from ${page}, so the call is cross-origin: check ` +
    `that ${target} is reachable and that the browser did not reject the ` +
    `CORS preflight (the network tab shows the OPTIONS request).`
  );
}
