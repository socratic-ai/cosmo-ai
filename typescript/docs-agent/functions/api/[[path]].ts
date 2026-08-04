import { COSMO_DEFAULT_BASE_URL, resolveCredential, type Env } from '../_credential';

/**
 * The deployed counterpart of the `/api` proxy in vite.config.ts. Cosmo's
 * ALLOWED_ORIGINS admits only Cosmo's own surfaces, so a browser on
 * *.pages.dev calling the external API directly is refused before the request
 * is read — the workaround is not a dev convenience, it is what any
 * third-party deployment has to do. The LiveKit connection that follows is a
 * WebSocket to an absolute URL and is not proxied.
 */
export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  const credential = resolveCredential(request, env);
  if (credential instanceof Response) return credential;

  const incoming = new URL(request.url);
  const upstream = new URL(env.COSMO_BASE_URL || COSMO_DEFAULT_BASE_URL);
  upstream.pathname = incoming.pathname;
  upstream.search = incoming.search;

  const headers = new Headers(request.headers);
  headers.set('authorization', `Bearer ${credential}`);
  headers.delete('host');
  headers.delete('origin');
  headers.delete('referer');
  headers.delete('cookie');

  const response = await fetch(upstream, {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    redirect: 'manual',
  });

  const out = new Headers(response.headers);
  out.delete('set-cookie');
  return new Response(response.body, { status: response.status, headers: out });
};
