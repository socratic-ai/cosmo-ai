export type Env = {
  COSMO_API_KEY?: string;
  COSMO_BASE_URL?: string;
  APP_PASSWORD?: string;
};

export const COSMO_DEFAULT_BASE_URL = 'https://platform.askcosmo.ai';

export function bearer(request: Request): string {
  const header = request.headers.get('authorization') ?? '';
  return header.replace(/^Bearer\s+/i, '').trim();
}

const LOOPBACK_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

/**
 * Gate a Function behind the deployment's shared password. Exactly one of
 * `APP_PASSWORD` / `COSMO_API_KEY` set is always a misconfiguration and
 * refuses rather than serving a degraded mode: a key with no password would
 * mint sessions for anyone who found the URL, and a password with no key
 * would fall through to forwarding the password itself upstream as if it
 * were the workspace credential (see `token.ts`).
 *
 * With neither set, the caller's own bearer value is used as the key
 * directly — but only when `request`'s own origin is loopback (`wrangler
 * pages dev` against a local `.env`, testing the hosted UI without
 * provisioning real Cloudflare secrets). Gating on the request's origin
 * rather than just "no secrets configured" matters: a public Pages
 * deployment that forgot to set secrets is otherwise indistinguishable from
 * that local case, and would silently start forwarding whatever visitors
 * type as if it were a Cosmo API key instead of refusing a broken
 * deployment.
 */
export function checkPassword(request: Request, env: Env): Response | null {
  if (Boolean(env.APP_PASSWORD) !== Boolean(env.COSMO_API_KEY)) {
    console.error('APP_PASSWORD and COSMO_API_KEY must be set together; refusing.');
    return Response.json({ error: 'This deployment is misconfigured.' }, { status: 500 });
  }
  if (!env.APP_PASSWORD) {
    if (LOOPBACK_HOSTNAMES.includes(new URL(request.url).hostname)) return null;
    console.error('No APP_PASSWORD/COSMO_API_KEY configured on a non-local deployment; refusing.');
    return Response.json({ error: 'This deployment is misconfigured.' }, { status: 500 });
  }
  if (bearer(request) !== env.APP_PASSWORD) {
    return Response.json({ error: 'Wrong access password for this deployment.' }, { status: 401 });
  }
  return null;
}

/**
 * `COSMO_BASE_URL` carries the workspace API key on every mint request, so
 * an unvalidated value can send it to an unintended origin. https-only
 * except loopback, matching what an unset value already resolves to.
 */
export function checkBaseUrl(base: string): Response | null {
  let hostname: string;
  try {
    hostname = new URL(base).hostname;
  } catch {
    return Response.json({ error: 'COSMO_BASE_URL is not a valid URL.' }, { status: 500 });
  }
  const isLoopback = LOOPBACK_HOSTNAMES.includes(hostname);
  if (!base.startsWith('https://') && !isLoopback) {
    return Response.json(
      { error: 'COSMO_BASE_URL must use https (the API key rides every request).' },
      { status: 500 },
    );
  }
  return null;
}
