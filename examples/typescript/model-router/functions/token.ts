import { COSMO_DEFAULT_BASE_URL, bearer, checkBaseUrl, checkPassword, type Env } from './_auth';

const EXTERNAL_USER_ID_PATTERN = /^[A-Za-z0-9._+@-]{1,128}$/;

/**
 * The deployment's token endpoint: trades the shared access password for a
 * short-lived end-user token, which the page consumes through
 * `TokenSource.endpoint('/token', ...)` and then talks to the Cosmo API
 * directly (`/api/v1/external/*` answers wildcard CORS). The workspace key
 * stays server-side and only ever mints — use a key with just the
 * `user_tokens:mint` scope, so a leak can't start sessions or dial.
 *
 * The same trade in template form, with pluggable real auth instead of a
 * shared password: ../token-server.
 */
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const denied = checkPassword(request, env);
  if (denied) return denied;

  // checkPassword only lets a no-secrets request through when it's loopback
  // (`wrangler pages dev` against a local .env) — there, the caller's own
  // value is the key, so pasting a workspace key into the password box mints
  // against it. Any other request reaching here already has both secrets set.
  const apiKey = env.COSMO_API_KEY || bearer(request);
  if (!apiKey) {
    return Response.json({ error: 'No credential configured.' }, { status: 500 });
  }

  const externalUserId = request.headers.get('x-external-user-id') ?? '';
  if (!EXTERNAL_USER_ID_PATTERN.test(externalUserId)) {
    return Response.json(
      { error: 'X-External-User-Id must match [A-Za-z0-9._+@-]{1,128}.' },
      { status: 422 },
    );
  }

  const base = (env.COSMO_BASE_URL || COSMO_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const badBase = checkBaseUrl(base);
  if (badBase) return badBase;

  const upstream = await fetch(`${base}/api/v1/external/auth/token`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ external_user_id: externalUserId }),
    // The key rides this request — never let a redirect carry it to a
    // different origin than the one that was validated above.
    redirect: 'error',
  });

  const headers = new Headers(upstream.headers);
  headers.delete('set-cookie');
  return new Response(upstream.body, { status: upstream.status, headers });
};
