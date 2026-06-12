# @bkey/login

**Login with bkey** — drop-in passwordless, biometric, phishing-resistant
sign-in for your site. Your users sign in by approving on their phone with
their face; you get a stable pseudonymous ID (`sub`). No passwords, no email
round-trips, nothing to breach.

```bash
npm install @bkey/login
```

## 1. Get credentials (self-serve, no dashboard needed)

```ts
import { registerClient } from '@bkey/login';

const { clientId, clientSecret } = await registerClient({
  issuer: 'https://auth.bkey.id',
  redirectUris: ['https://yourapp.com/auth/callback/bkey'],
  clientName: 'Your App',
});
// Store clientSecret like a password — it is shown exactly once.
```

(Equivalent one-liner: `curl -X POST https://auth.bkey.id/oauth/register ...` —
RFC 7591. Zero-registration CIMD is also supported: host a client metadata
document and use its URL as your `client_id`.)

## 2a. Next.js / Auth.js — the 5-line version

```ts
// auth.ts
import NextAuth from 'next-auth';
import { BkeyProvider } from '@bkey/login/authjs';

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [BkeyProvider({
    clientId: process.env.BKEY_CLIENT_ID!,
    clientSecret: process.env.BKEY_CLIENT_SECRET!,
  })],
});
```

Auth.js handles discovery, PKCE, nonce, and EdDSA id_token verification.
`session.user.id` is the user's bkey ID. Working app:
[`examples/typescript/login-with-bkey-nextjs`](../../../examples/typescript/login-with-bkey-nextjs).

## 2b. Any framework — the core helpers

```ts
import { createBkeyLogin } from '@bkey/login';

const bkey = createBkeyLogin({
  issuer: 'https://auth.bkey.id',
  clientId: process.env.BKEY_CLIENT_ID!,
  clientSecret: process.env.BKEY_CLIENT_SECRET,
  redirectUri: 'https://yourapp.com/auth/callback/bkey',
});

// Start sign-in (persist state/nonce/codeVerifier in the session):
const auth = await bkey.authorizationUrl();
res.redirect(auth.url);

// On your callback route:
const user = await bkey.handleCallback(req.url, savedAuth);
console.log(user.sub); // 'did:bkey:z...' — the user's stable bkey ID

// Sign out (OIDC RP-Initiated Logout):
res.redirect(await bkey.endSessionUrl({ idToken: user.idToken }));
```

`handleCallback` verifies everything before returning: state (CSRF), PKCE,
id_token signature against bkey's published JWKS (EdDSA default / RS256
opt-in), issuer, audience, expiry, and nonce (replay).

## What your users see

Your site redirects to the bkey consent page; the user scans a QR (or taps
through on mobile), confirms the on-screen pairing code matches their phone,
and approves with their face. No password ever exists.

## Privacy model (v1)

The id_token carries exactly one identity claim: `sub`, a pseudonymous DID.
Name/email are **not** shared — render your own profile UX on first login.

## Related packages

- [`@bkey/sdk`](../sdk) — biometric approvals (CIBA), vault, checkout for AI agents
- `@bkey/approvals-verify` — offline verification of bkey approval receipts and id_tokens
