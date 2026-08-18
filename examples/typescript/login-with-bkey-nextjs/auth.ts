import NextAuth from 'next-auth';
import { BkeyProvider } from '@bkey/login/authjs';

/**
 * MUST be the host whose discovery document declares itself as the issuer —
 * `id.bkey.id`. `auth.bkey.id` and `api.bkey.id` also answer discovery, but the
 * document they return declares `"issuer": "https://id.bkey.id"`, so either one
 * fails the mandatory OIDC issuer-equality check (`issuer_mismatch`) before
 * sign-in can start. The register script pins this into .env.local so the
 * issuer you register against and the one you authenticate against can't drift.
 */
export const BKEY_ISSUER = process.env.BKEY_ISSUER ?? 'https://id.bkey.id';

// The entire integration. session.user.id is the user's stable, pseudonymous
// bkey ID (a DID) — no passwords, no email round-trips.
export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    BkeyProvider({
      clientId: process.env.BKEY_CLIENT_ID!,
      clientSecret: process.env.BKEY_CLIENT_SECRET!,
      issuer: BKEY_ISSUER,
    }),
  ],
  callbacks: {
    // Keep the id_token on the encrypted, httpOnly session cookie — it is
    // needed as `id_token_hint` for RP-initiated logout (see lib/bkey.ts).
    // Deliberately NOT copied onto `session` below, which the browser can read
    // at /api/auth/session.
    jwt({ token, account }) {
      if (account?.id_token) token.idToken = account.id_token as string;
      return token;
    },
    // Surface the bkey ID on the session object.
    session({ session, token }) {
      if (token.sub) session.user = { ...session.user, id: token.sub };
      return session;
    },
    // Auth.js refuses off-origin redirects by default. Allow exactly one
    // external target — the bkey issuer — so sign-out can hand off to the
    // end_session endpoint. Everything else still falls back to this app.
    //
    // Compare ORIGINS, never string prefixes. `url.startsWith(baseUrl)` has no
    // trailing delimiter, so `http://localhost:3000.evil.example/phish` would
    // pass — an open redirect, and precisely the protection the Auth.js default
    // provides. Widen that default by one origin; don't weaken it. Relative
    // URLs are resolved against baseUrl first.
    redirect({ url, baseUrl }) {
      const appOrigin = new URL(baseUrl).origin;
      let target: URL;
      try {
        target = new URL(url, baseUrl);
      } catch {
        return baseUrl;
      }
      if (target.origin === new URL(BKEY_ISSUER).origin) return target.toString();
      return target.origin === appOrigin ? target.toString() : baseUrl;
    },
  },
});
