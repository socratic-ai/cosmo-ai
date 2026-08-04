export type Env = {
  COSMO_API_KEY?: string;
  COSMO_BASE_URL?: string;
  APP_PASSWORD?: string;
};

export const COSMO_DEFAULT_BASE_URL = 'https://platform.askcosmo.ai';

function bearer(request: Request): string {
  const header = request.headers.get('authorization') ?? '';
  return header.replace(/^Bearer\s+/i, '').trim();
}

/**
 * What the browser sends is never a Cosmo credential in a deployed build:
 * a Vite bundle is public, so the real workspace key stays here as a secret
 * and the box in the UI holds a shared password instead. This checks that
 * password and hands back the key to use upstream.
 *
 * With no secrets configured the caller's own value is passed through, which
 * is what `wrangler pages dev` against a local `.env` does.
 */
export function resolveCredential(request: Request, env: Env): string | Response {
  const presented = bearer(request);
  if (!env.COSMO_API_KEY) return presented;

  // A deployment holding a key but no password would hand that key's sessions
  // to anyone who found the URL, so refuse rather than serve unauthenticated.
  if (!env.APP_PASSWORD) {
    console.error('COSMO_API_KEY is set without APP_PASSWORD; refusing to proxy.');
    return Response.json({ error: 'This deployment is misconfigured.' }, { status: 500 });
  }
  if (presented !== env.APP_PASSWORD) {
    return Response.json({ error: 'Wrong access password for this deployment.' }, { status: 401 });
  }
  return env.COSMO_API_KEY;
}
