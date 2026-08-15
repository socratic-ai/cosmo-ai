/**
 * The page's own origin, when running in a browser.
 *
 * Shared by the ``baseUrl`` fallback (a browser may omit it and target the
 * page's origin) and by the cross-origin diagnosis in
 * ``transport/fetch_failure``, so both agree on what "in a browser" means.
 */

/** The page's origin, or null outside a browser. */
export function pageOrigin(): string | null {
  if (typeof window !== 'undefined' && window.location?.origin) return window.location.origin;
  return null;
}
