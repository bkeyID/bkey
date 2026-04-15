# BKey vault-access example

A tiny CLI that stores and retrieves **end-to-end encrypted secrets** from a BKey vault with biometric approval from the owner's phone.

BKey's vault is E2EE: the server only ever sees ciphertext. Plaintext crosses the wire only after the user approves the specific release on their phone using facial biometrics — and even then it's sealed to an ephemeral key the requesting process generated for that single access.

This example shows the full client-side crypto envelope so you can see exactly what is encrypted, when, and against whose key.

```
vault-access CLI            BKey                 owner's phone
      │                      │                      │
      ├── store "openai" sk- │                      │
      │     (E2EE envelope) ─▶                      │
      │                      ├── push ─────────────▶│
      │                      │    confirm on device─┤
      │                      │◀── stored ───────────┤
      │◀── stored ───────────┤                      │
      │                      │                      │
      ├── access "openai" ──▶│                      │
      │     (ephemeral pub)  │                      │
      │                      ├── push ─────────────▶│
      │                      │       facial bio ────┤
      │                      │◀── sealed ciphertext ┤
      │◀── sealed ciphertext ┤                      │
      │ (decrypt with        │                      │
      │  ephemeral priv)     │                      │
```

## What it exposes

Two subcommands against a single vault item:

| Command | Behavior |
|---|---|
| `store <name> <value>` | Encrypts `value` client-side to the vault's public key (X25519 ECDH + AES-256-GCM), uploads the sealed payload, waits for the phone to confirm storage. |
| `access <name>` | Generates a fresh ephemeral X25519 keypair, asks the phone to release the named item sealed to that public key, polls, decrypts locally, writes the plaintext to stdout. |

Values are stored under a single `key` field, matching the default used by `bkey proxy` and `bkey wrap` — so a secret stored with this example can immediately be referenced as `{vault:name}` by the main BKey CLI.

## Setup

This example installs `@bkey/sdk` straight from npm — it's a standalone package you can copy out of the monorepo unchanged.

```bash
cd examples/typescript/vault-access
npm install
npm run build
```

Create a `.env` file next to `package.json` (copy from `.env.example`) and fill in:

| Variable | Where to get it |
|---|---|
| `BKEY_CLIENT_ID` / `BKEY_CLIENT_SECRET` | Register an **agent client** at [bkey.id](https://bkey.id) (agent clients use the `client_credentials` grant). |
| `BKEY_USER_DID` | The user who owns the vault and will receive approval pushes. In the BKey mobile app: Settings → Developer → Copy DID. |

Then, in the BKey mobile app, open the vault once so the phone generates its X25519 keypair and publishes the public key. Until this happens, `store` will fail with "no vault encryption key found."

## Running it

Store:

```bash
node dist/index.js store openai sk-proj-abc123...
# Sending "openai" to your phone for storage…
# Waiting for approval on your phone…
# [tap approve on phone]
# Stored "openai" on your device.
```

Retrieve (writes plaintext to stdout, progress to stderr — safe to redirect):

```bash
node dist/index.js access openai > key.txt
# Requesting access to "openai"… waiting for approval on your phone…
# [facial biometrics on phone]
cat key.txt
# sk-proj-abc123...
```

With a purpose string (shown on the phone next to the item name):

```bash
node dist/index.js access openai --purpose "Nightly backfill run"
```

## How the E2EE flow works

### Store

1. CLI calls `getVaultPublicKey()` to fetch the phone's X25519 public key. The server relays this from what the phone published at vault-creation time; the server does **not** have the private half.
2. CLI generates an ephemeral X25519 keypair, ECDH's against the phone key, SHA-256's the shared secret into a 32-byte AES key, and encrypts `JSON.stringify({key: value})` with AES-256-GCM.
3. CLI uploads `version(0x02) || ephemeralPub(32) || iv(12) || authTag(16) || ciphertext` as a single base64 blob via `createStoreRequest`.
4. The phone receives a push, decrypts using its vault private key + the ephemeral public key from the envelope, shows the user the field names it is about to store, and waits for biometric confirmation.
5. `pollStoreRequest` returns `{ status: 'stored' }` once the phone writes the item to its encrypted local store.

At no point does the server see plaintext. If the server is compromised during this flow, the attacker gets an opaque envelope they cannot open.

### Access

1. CLI generates a **new** ephemeral X25519 keypair per access. The private half never leaves this process.
2. CLI calls `createAccessRequest({ itemName, fieldPath, purpose, ephemeralPublicKey })`. The server records the request and pushes a notification to the phone.
3. The user sees `purpose` + item name on their phone, approves with facial biometrics.
4. The phone decrypts the stored item locally, re-encrypts the requested field to the CLI's ephemeral public key (X25519 ECDH + AES-256-GCM), and uploads the sealed ciphertext.
5. `pollAccessRequest` returns when status flips to `approved`, carrying the sealed ciphertext.
6. CLI decrypts with its ephemeral private key and prints the plaintext.

Because the ephemeral keypair is thrown away after this single access, even if an attacker later captures both the ciphertext and the server's logs, they have no key to open it.

## Design rules

**Always set a meaningful `purpose`.** The user sees it on their phone next to the item name. "Nightly backfill — cron job on api-01" is a better prompt than "CLI access" — the user can decide "yes this is mine, not an attacker."

**One access request = one release.** Access request IDs are single-use. Don't cache them; make a fresh request every time you need the secret. (The same applies to the underlying `jti` on the release token server-side — treat them as nonces.)

**New ephemeral keypair per access — never reuse.** The private key should exist in memory only for the lifetime of one request. Reusing it across accesses defeats the forward-secrecy guarantee of the ephemeral-key model.

**Tight `expiresInSecs`.** This example uses 300s. Long enough for a human to pick up their phone, short enough that a stolen terminal with a queued request can't wait hours for the phone to be set down unattended.

**Don't log the plaintext.** The output lands on stdout deliberately so you can pipe it into an env var or a file without it crossing the rest of your log pipeline.

## Extending this

- **Per-user shared CLI.** This example hardcodes one `BKEY_USER_DID`. For a multi-user tool, resolve the DID from your session or from a pairing flow (see [device authorization](https://github.com/bkeyID/bkey/blob/main/docs/authentication/device-authorization.mdx)).
- **Richer items.** `store <name> <value>` is the single-field case. The store endpoint accepts an `itemType`, multiple fields (as a JSON object), tags, and a website URL — swap in your own structure and update the field map.
- **Combined with approval.** Fetching the secret tells you *what* to use; gating the subsequent action behind `bkey.approve()` confirms *whether* to use it. Many production integrations do both — see [`examples/typescript/mcp-server`](../mcp-server/) for the approval pattern.

## References

- [`@bkey/sdk` on npm](https://www.npmjs.com/package/@bkey/sdk) — vault + approval client
- [BKey vault secrets guide](https://github.com/bkeyID/bkey/blob/main/docs/guides/vault-secrets.mdx)
- [`@bkey/cli` vault command](https://github.com/bkeyID/bkey/blob/main/typescript/packages/cli/src/commands/vault.ts) — reference implementation the envelope format tracks
- [X25519 (RFC 7748)](https://datatracker.ietf.org/doc/html/rfc7748) / [AES-GCM (NIST SP 800-38D)](https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38d.pdf)
