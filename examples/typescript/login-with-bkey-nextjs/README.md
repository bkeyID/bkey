# Login with bkey — Next.js quickstart

Passwordless, biometric sign-in on a Next.js (App Router) site in ~5 lines,
via [Auth.js](https://authjs.dev) + [`@bkey/login`](../../../typescript/packages/login).

## Run it

```bash
npm install

# 1. Get credentials — self-serve, no dashboard, no account (RFC 7591):
BKEY_ISSUER=https://staging-api.bkey.id npm run register
#    → paste ALL printed lines (BKEY_ISSUER / BKEY_CLIENT_ID / BKEY_CLIENT_SECRET /
#      AUTH_SECRET) into .env.local. BKEY_ISSUER pins the app to the SAME issuer you
#      registered against — without it the app defaults to production and would reject
#      a staging-registered client.

# 2. Go
npm run dev   # http://localhost:3000 → "Sign in with bkey"
```

The full integration is [`auth.ts`](./auth.ts) — `BkeyProvider` + your
credentials. Auth.js handles discovery, PKCE, nonce, and EdDSA id_token
verification; `session.user.id` is the user's stable pseudonymous bkey ID.

## What the user experiences

Click "Sign in with bkey" → bkey consent page (QR on desktop / app hand-off
on mobile) → confirm the pairing code matches the phone → approve with your
face → you're back, signed in. No password exists anywhere in this flow.

## Notes

- bkey shares exactly one claim: `sub` (a pseudonymous DID). Collect
  name/email in your own onboarding if you need them.
- Requires a bkey environment with Login with bkey enabled
  (`staging-api.bkey.id` during the beta).
