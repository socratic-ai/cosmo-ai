import { resolveCredential, type Env } from '../_credential';

/** Answers "is this password right?" without starting a session, so the UI can
 *  say so at the point the password is typed rather than at the first thing
 *  the user tries to do. */
export const onRequestPost: PagesFunction<Env> = ({ request, env }) => {
  const credential = resolveCredential(request, env);
  if (credential instanceof Response) return credential;
  return Response.json({ ok: true });
};
