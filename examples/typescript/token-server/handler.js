/**
 * Cosmo token server — the one backend piece a distributed app needs.
 *
 * Holds your COSMO_API_KEY (a server-side secret) and trades it for
 * short-lived end-user tokens: `POST /token` forwards to Cosmo's
 * `POST /api/v1/external/auth/token` and returns `{ jwt, expires_at }`,
 * which every Cosmo SDK consumes directly via `TokenSource.endpoint(...)`.
 *
 * Written against the web-standard fetch API (Request/Response), so this
 * exact file runs on Cloudflare Workers, Deno Deploy, Vercel, Netlify, and
 * Bun as-is; `server.js` adapts it to Node, `lambda.js` to AWS Lambda.
 * Zero dependencies.
 */

const DEFAULT_BASE_URL = 'https://platform.askcosmo.ai';
const EXTERNAL_USER_ID_PATTERN = /^[A-Za-z0-9._+@-]{1,128}$/;

/**
 * Who is this request for? Return the external user id to mint for, or
 * null to refuse with 401.
 *
 * ─── EDIT THIS for production ────────────────────────────────────────────
 * Replace the MINT_SECRET check with your app's real auth: verify the
 * session cookie / Firebase / Clerk / Supabase / your own JWT that your
 * app already sends, and return YOUR stable id for that user (their
 * account id, email, ...). Cosmo meters and scopes per this id.
 *
 * The default behavior needs MINT_SECRET set: callers must send
 * `Authorization: Bearer <MINT_SECRET>` and name the user in an
 * `X-External-User-Id` header (or `external_user_id` in the JSON body).
 * A shared secret is fine for server-to-server calls and closed betas,
 * but anything shipped to strangers can be unpacked — real distribution
 * means verifying each user's own identity here instead.
 * ─────────────────────────────────────────────────────────────────────────
 */
async function identifyUser(request, env, body) {
  if (!env.MINT_SECRET) return null;
  const auth = request.headers.get('authorization') ?? '';
  if (auth !== `Bearer ${env.MINT_SECRET}`) return null;
  return request.headers.get('x-external-user-id') ?? body?.external_user_id ?? null;
}

class BodyTooLargeError extends Error {}

/** Read the body while counting bytes — a Content-Length check alone is
 *  bypassed by chunked requests, which carry none. */
async function readBodyCapped(request, maxBytes) {
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type, x-external-user-id',
  };
}

function json(status, body, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env) },
  });
}

async function handleToken(request, env) {
  if (!env.COSMO_API_KEY) {
    return json(500, { error: { type: 'config', message: 'COSMO_API_KEY is not set' } }, env);
  }
  let body = null;
  try {
    body = JSON.parse(await readBodyCapped(request, 8_192));
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return json(413, { error: { type: 'validation', message: 'request body too large' } }, env);
    }
    // An empty or non-JSON body is fine — TokenSource.endpoint sends `{}`
    // and names the user in a header.
  }

  const externalUserId = await identifyUser(request, env, body);
  if (externalUserId === null) {
    const message = env.MINT_SECRET
      ? 'Unauthorized: send Authorization: Bearer <MINT_SECRET> and X-External-User-Id.'
      : 'Not configured: set MINT_SECRET, or implement identifyUser() for your auth.';
    return json(env.MINT_SECRET ? 401 : 503, { error: { type: 'auth', message } }, env);
  }
  if (!EXTERNAL_USER_ID_PATTERN.test(externalUserId)) {
    return json(
      422,
      { error: { type: 'validation', message: 'external_user_id must match [A-Za-z0-9._+@-]{1,128}' } },
      env,
    );
  }

  const baseUrl = (env.COSMO_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const upstreamHost = new URL(baseUrl).hostname;
  if (!baseUrl.startsWith('https://') && !['localhost', '127.0.0.1', '[::1]'].includes(upstreamHost)) {
    return json(500, { error: { type: 'config', message: 'COSMO_BASE_URL must use https (the API key rides every request)' } }, env);
  }
  const upstream = await fetch(`${baseUrl}/api/v1/external/auth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.COSMO_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ external_user_id: externalUserId }),
    redirect: 'error',
  });
  // Pass Cosmo's response through untouched — `{ jwt, expires_at }` on
  // success, the error envelope + status on rejection.
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env) },
  });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }
    if (request.method === 'GET' && pathname === '/healthz') {
      return new Response('ok', { headers: corsHeaders(env) });
    }
    if (request.method === 'POST' && pathname === '/token') {
      return handleToken(request, env);
    }
    return json(404, { error: { type: 'not_found', message: `no route for ${request.method} ${pathname}` } }, env);
  },
};
