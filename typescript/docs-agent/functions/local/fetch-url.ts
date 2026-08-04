import { readPage, screenHostLiterally } from '../../shared/page.js';
import { resolveCredential, type Env } from '../_credential';

/**
 * Workers have no DNS resolver, so the address screen is the literal-host one
 * plus the platform's own refusal to route `fetch` into private space — a
 * DNS answer in RFC1918 is unreachable here rather than merely rejected.
 */
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const credential = resolveCredential(request, env);
  if (credential instanceof Response) return credential;

  let payload: { url?: unknown };
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: 'Expected a JSON body.' }, { status: 400 });
  }

  const { status, body } = await readPage(payload?.url, async (host: string) => screenHostLiterally(host));
  return Response.json(body, { status });
};
