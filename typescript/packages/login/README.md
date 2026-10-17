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

const registration = await registerClient({
  issuer: 'https://id.bkey.id',
  redirectUris: ['https://yourapp.com/auth/callback/bkey'],
  clientName: 'Your App',
});

const {
  clientId,
  clientSecret,
  registrationClientUri,
  registrationAccessToken,
} = registration;
```

Store `clientSecret` like a password. Store `registrationAccessToken` as a
separate sensitive credential. An anonymous registration returns the
registration access token only once. You need it to read, update, rotate, claim,
or delete the client later. The client secret cannot manage the registration.

(Equivalent one-liner: `curl -X POST https://id.bkey.id/oauth/register ...` -
RFC 7591. Zero-registration CIMD is also supported: host a client metadata
document and use its URL as your `client_id`.)

### Manage a registered client

The lifecycle helpers use the per-client `registrationClientUri`. For an
anonymous client, use the one-time registration access token:

In production, the issuer is `https://id.bkey.id`, but the backend can return a
management URI on `https://api.bkey.id`. The SDK accepts this exact BKey host
pair and same-origin management URIs. It rejects all other cross-origin values.

```ts
import {
  deleteRegisteredClient,
  getRegisteredClient,
  rotateClientSecret,
  updateRegisteredClient,
  uploadRegisteredClientLogo,
} from '@bkey/login';

const management = {
  issuer: 'https://id.bkey.id',
  registrationClientUri,
  managementAccessToken: registrationAccessToken!,
};

const current = await getRegisteredClient(management);

// Upload or replace the client logo after registration.
// Node Buffer extends Uint8Array, so readFile output works directly.
const { readFile } = await import('node:fs/promises');
const { logoUri } = await uploadRegisteredClientLogo({
  ...management,
  logoPng: await readFile('./logo.png'),
});

await updateRegisteredClient({
  ...management,
  redirectUris: ['https://yourapp.com/auth/callback/bkey'],
  postLogoutRedirectUris: ['https://yourapp.com/signed-out'],
  clientName: 'Your App',
});

const rotated = await rotateClientSecret({
  ...management,
  graceHours: 24,
});
// Store rotated.clientSecret. It is returned only once.
```

In a browser, `logoPng` can also be a `Blob` or `File`. The helper sends raw
PNG bytes. Do not base64-encode the file or use multipart form data. The
helper rejects empty files and files over 256 KiB before it sends a request.
The backend rejects invalid or animated PNG files and returns the public CDN
URL as `logoUri`. Later client metadata reads also include `logoUri`.

Logo upload is a separate operation because client registration and R2 upload
are not one transaction. Always store the registration result first. If an
upload fails, keep the client credentials and retry only the upload.

`graceHours` defaults to `24`. Set it to `0` to stop old secrets immediately
after a leak.

RFC 7592 permits a read or update response to replace the registration access
token or client secret. BKey does not currently rotate either credential on
these operations. If a response includes `registrationAccessToken` or
`clientSecret`, replace the stored credential before the next request.

Delete a registration only when you intend to deprovision it:

```ts
await deleteRegisteredClient(management);
```

To claim an anonymous client, send both the new owner's user or developer
dashboard access token and the registration access token:

```ts
import { claimRegisteredClient } from '@bkey/login';

await claimRegisteredClient({
  issuer: 'https://id.bkey.id',
  registrationClientUri,
  ownerAccessToken,
  registrationAccessToken: registrationAccessToken!,
});
```

Claiming revokes the registration access token. After a claim, pass the owner's
user or developer dashboard token as `managementAccessToken` for later
management calls.

The SDK does not change an existing management options object. Create new
options or replace its `managementAccessToken` before the next management call:

```ts
const ownedManagement = {
  ...management,
  managementAccessToken: ownerAccessToken,
};

await getRegisteredClient(ownedManagement);
```

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
  issuer: 'https://id.bkey.id',
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

// Revoke a token (RFC 7009):
if (user.accessToken) {
  await bkey.revokeAccessToken(user.accessToken);
}
if (user.refreshToken) {
  await bkey.revokeRefreshToken(user.refreshToken);
}

// Sign out (OIDC RP-Initiated Logout):
res.redirect(await bkey.endSessionUrl({ idToken: user.idToken }));
```

Revocation applies only to the submitted token. Revoking a refresh token does
not revoke related access tokens. Revoke both tokens to end both credentials.
The full revocation operation, including discovery, has a five-second deadline.
Pass `{ signal }` as the second argument to cancel it sooner. A caller signal
does not disable the default deadline.

`handleCallback` verifies everything before returning: state (CSRF), PKCE,
id_token signature against bkey's published JWKS (EdDSA), issuer, audience,
expiry, and nonce (replay).

## Timeouts and retries

Every network call the SDK makes runs under one deadline —
`DEFAULT_REQUEST_TIMEOUT_MS` (30 seconds) — and every operation accepts a
`timeoutMs` option to change it per call. `createBkeyLogin({ timeoutMs })`
sets the default for that client's discovery, `handleCallback()` code
exchange, JWKS fetch, and token revocation; `handleCallback(url, expected,
{ timeoutMs })` and `revoke*Token(token, { timeoutMs })` override it per call.
A caller-supplied `signal` still cancels sooner.

When the deadline fires the call rejects with a `BkeyLoginError` whose `code`
is `request_timeout` (the platform `TimeoutError` is on `cause`). **A timeout
is not a failure report from the server.** The request may still have
completed after the deadline, so treat each operation according to what a
duplicate would do:

| Operation                                             | Safe to retry after `request_timeout`?                                                                                                                                            |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getRegisteredClient()`, discovery                    | Yes — reads are idempotent. Retry with backoff.                                                                                                                                   |
| `updateRegisteredClient()`, `uploadRegisteredClientLogo()` | Yes, with the same payload — then read the client back to confirm.                                                                                                        |
| `deleteRegisteredClient()`, `revoke*Token()`          | Yes — deleting or revoking something already gone succeeds.                                                                                                                       |
| `registerClient()`                                    | **No.** A second call creates a second client. Read back your registrations (or contact support) before registering again.                                                        |
| `rotateClientSecret()`                                | **No.** A second call rotates again and the timed-out secret — which may already be live — is never returned. Reconcile first: if your old secret has stopped working, the rotation went through and you must rotate once more, deliberately, with a longer `timeoutMs`. |
| `claimRegisteredClient()`                             | Reconcile ownership first (`getRegisteredClient()` with the owner token); retry only if the client is still unclaimed.                                                             |
| `handleCallback()`                                    | **No.** The authorization code is single-use. Send the user through sign-in again.                                                                                                |

`registerClient()` and `rotateClientSecret()` do not yet accept an idempotency
key; that is backend work tracked in
[bkeyID/bkey#88](https://github.com/bkeyID/bkey/issues/88). Until it lands,
give those two calls a generous `timeoutMs` rather than a tight one — a cold
bkey deployment has been measured taking more than five seconds on a rotation.

## What your users see

Your site redirects to the bkey consent page; the user scans a QR (or taps
through on mobile), confirms the on-screen pairing code matches their phone,
and approves with their face. No password ever exists.

## Privacy model (v1)

The id_token carries exactly one identity claim: `sub`, a pseudonymous DID.
Name/email are **not** shared — render your own profile UX on first login.

## Environments

| Environment | Issuer | Approve with |
| --- | --- | --- |
| Production (default) | `https://id.bkey.id` | the bkey app from the App Store |
| Staging | `https://staging-api.bkey.id` | a staging-enrolled device |

Register and authenticate against the **same** issuer — a client registered on one
is unknown to the other. Pass `issuer` explicitly (or set `BKEY_ISSUER`) for staging;
production is the default.

> Use the issuer hosts above verbatim. `auth.bkey.id` also answers discovery, but the
> document it returns declares `"issuer": "https://id.bkey.id"` — so configuring
> `auth.bkey.id` fails the mandatory OIDC issuer-equality check (`issuer_mismatch`)
> before sign-in can start.

## Related packages

- [`@bkey/sdk`](../sdk) — biometric approvals (CIBA), vault, checkout for AI agents
- `@bkey/approvals-verify` — offline verification of bkey approval receipts and id_tokens
