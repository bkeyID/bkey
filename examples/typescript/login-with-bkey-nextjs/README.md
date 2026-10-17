# Login with bkey — Next.js quickstart

Passwordless, biometric sign-in on a Next.js (App Router) site in ~5 lines,
via [Auth.js](https://authjs.dev) + [`@bkey/login`](https://www.npmjs.com/package/@bkey/login).

You will need the bkey app on your phone to approve the sign-in.

## Run it

```bash
# 0. Install dependencies (@bkey/login comes from npm)
npm install

# 1. Get credentials — self-serve, no dashboard, no account (RFC 7591):
npm run register
#    → paste ALL printed lines (BKEY_ISSUER / BKEY_CLIENT_ID / BKEY_CLIENT_SECRET /
#      AUTH_SECRET) into .env.local. BKEY_ISSUER pins the app to the SAME issuer you
#      registered against, so the two can never drift.

# 2. Go
npm run dev   # http://localhost:3000 → "Sign in with bkey"
```

This registers against production (`https://id.bkey.id`), which is what the App Store
app is enrolled in. To use staging instead, prefix **both** commands with
`BKEY_ISSUER=https://staging-api.bkey.id` — that needs a staging-enrolled device.

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
- Register and sign in against the **same** issuer — a client registered on
  production is unknown to staging, and vice versa.
- Use `id.bkey.id` (or `staging-api.bkey.id`) verbatim as the issuer. `auth.bkey.id`
  answers discovery too, but the document it returns declares
  `"issuer": "https://id.bkey.id"`, so pointing a client at it fails the mandatory
  OIDC issuer-equality check (`issuer_mismatch`).
