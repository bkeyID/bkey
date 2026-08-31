import { cookies, headers } from 'next/headers';
import { getToken } from 'next-auth/jwt';
import { createBkeyLogin } from '@bkey/login';
import { BKEY_ISSUER } from '../auth';

export const APP_URL = process.env.APP_URL ?? 'http://localhost:3000';

/**
 * Auth.js prefixes its session cookie with `__Secure-` when the app is served
 * over HTTPS, and uses that same name as the JWE decryption salt.
 *
 * Derive it from the URL's protocol, exactly as Auth.js does — NOT from
 * NODE_ENV. Those agree in the two common cases (HTTP dev, HTTPS prod) and
 * disagree in a third that is easy to hit: a development server behind an HTTPS
 * tunnel, which is what you need in order to test on a physical phone. Guessing
 * wrong makes getToken return `null` with no error, so sign-out skips the
 * end_session hand-off.
 */
const USE_SECURE_COOKIES = new URL(APP_URL).protocol === 'https:';
const SESSION_COOKIE = `${USE_SECURE_COOKIES ? '__Secure-' : ''}authjs.session-token`;

/**
 * Read the id_token off the encrypted session cookie, server-side only.
 *
 * Deliberately via `getToken` rather than off the session object: anything on
 * `session` is readable by the browser at /api/auth/session, and an id_token is
 * a bearer assertion of the user's identity.
 */
export async function getIdToken(): Promise<string | undefined> {
  const token = await getToken({
    req: { headers: await headers(), cookies: await cookies() } as never,
    secret: process.env.AUTH_SECRET!,
    salt: SESSION_COOKIE,
    secureCookie: USE_SECURE_COOKIES,
  });
  return typeof token?.idToken === 'string' ? token.idToken : undefined;
}

const bkey = createBkeyLogin({
  issuer: BKEY_ISSUER,
  clientId: process.env.BKEY_CLIENT_ID!,
  clientSecret: process.env.BKEY_CLIENT_SECRET,
  redirectUri: `${APP_URL}/api/auth/callback/bkey`,
});

/**
 * OIDC RP-Initiated Logout — the spec-standard logout hand-off.
 *
 * Note what this does NOT do. bkey is a stateless OP: it holds no browser
 * session of its own, and every /authorize triggers a fresh biometric approval.
 * So clearing this app's cookie already ends the sign-in, and there is no
 * lingering "still signed in at bkey" state for this call to clean up.
 *
 * `end_session` implements the logout redirect contract only — it verifies
 * `id_token_hint` and redirects to a registered URI. It does not revoke tokens;
 * `/oauth/revoke` does that. Use this for the standard hand-off, and revoke if
 * you are holding tokens that should stop working.
 *
 * `postLogoutRedirectUri` must be one of the `post_logout_redirect_uris` the
 * client was registered with — see scripts/register-client.mjs.
 */
export async function bkeyEndSessionUrl(idToken: string): Promise<string> {
  return bkey.endSessionUrl({ idToken, postLogoutRedirectUri: `${APP_URL}/` });
}
