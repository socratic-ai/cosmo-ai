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

/**
 * Gate a Function behind the deployment's shared password. A deployment
 * holding a key but no password would mint sessions for anyone who found
 * the URL, so that misconfiguration refuses rather than serving
 * unauthenticated. With no secrets configured (`wrangler pages dev`
 * against a local `.env`) everything is open.
 */
export function checkPassword(request: Request, env: Env): Response | null {
  if (!env.APP_PASSWORD) {
    if (env.COSMO_API_KEY) {
      console.error('COSMO_API_KEY is set without APP_PASSWORD; refusing.');
      return Response.json({ error: 'This deployment is misconfigured.' }, { status: 500 });
    }
    return null;
  }
  if (bearer(request) !== env.APP_PASSWORD) {
    return Response.json({ error: 'Wrong access password for this deployment.' }, { status: 401 });
  }
  return null;
}
