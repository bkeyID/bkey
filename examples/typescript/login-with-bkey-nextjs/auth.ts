import NextAuth from 'next-auth';
import { BkeyProvider } from '@bkey/login/authjs';

// The entire integration. session.user.id is the user's stable,
// pseudonymous bkey ID (a DID) — no passwords, no email round-trips.
export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    BkeyProvider({
      clientId: process.env.BKEY_CLIENT_ID!,
      clientSecret: process.env.BKEY_CLIENT_SECRET!,
      // MUST match the issuer you registered against — the register script
      // pins BKEY_ISSUER into .env.local so the two never drift. Falls back
      // to the @bkey/login production default when unset.
      issuer: process.env.BKEY_ISSUER,
    }),
  ],
  callbacks: {
    // Surface the bkey ID on the session object.
    session({ session, token }) {
      if (token.sub) session.user = { ...session.user, id: token.sub };
      return session;
    },
  },
});
