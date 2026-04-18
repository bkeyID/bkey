# TypeScript vault-access example

End-to-end example of a Node.js program that reads an encrypted secret from the BKey vault — decrypted only after the user approves on their phone with Face ID — and uses it in-process.

Also shows the **generic one-line CIBA approval** pattern for any sensitive action.

## Two things this example demonstrates

1. **Generic biometric approval** — `bkey.approve(...)` — the universal primitive for any sensitive action.
2. **End-to-end encrypted vault access** — full implementation of the X25519 + AES-256-GCM decrypt envelope, so your agent can read a vault secret without ever exposing it to the backend in plaintext.

## How the encryption works

See the [encryption guide](https://github.com/bkeyID/bkey/blob/main/docs/guides/encryption.mdx) for the whole picture. The short version:

1. Agent generates an **ephemeral X25519 keypair** per access request.
2. Agent sends the public key + item name + purpose to BKey.
3. BKey pushes a Face ID prompt to the user's phone.
4. Phone does X25519 ECDH with the ephemeral public key, derives `aesKey = SHA-256(sharedSecret)`, and encrypts the value with AES-256-GCM.
5. Ciphertext envelope: `phonePubKey(32) || iv(12) || authTag(16) || ciphertext`.
6. Agent decrypts with its ephemeral private key. Backend never sees plaintext.

This example implements step 6 using Node's built-in `crypto` module and `@noble/curves` — no extra dependencies beyond what `@bkey/sdk` already bundles.

## Quickstart

```bash
# 1. Install the CLI + this example
npm install -g @bkey/cli

cd examples/typescript/vault-access
npm install

# 2. Create agent credentials (once)
bkey auth login
bkey auth setup-agent --name "Vault Demo" --save

# 3. Store a test secret (one-time; triggers Face ID on your phone)
bkey vault store openai-api-key --field value=sk-test-...

# 4. Configure
cp .env.example .env
# Edit .env: BKEY_CLIENT_ID, BKEY_CLIENT_SECRET, BKEY_USER_DID

# 5. Run
npm run dev
```

You'll see two biometric prompts on the phone:
- First for the generic approval demo.
- Second for the vault access (decrypts the secret into this process).

## Code walkthrough

### Part 1 — Generic one-line approval

```typescript
const result = await bkey.approve('Read OPENAI_API_KEY for one API call', {
  scope: 'approve:action',
});
// result.accessToken is an EdDSA JWT
```

### Part 2 — Vault access with client-side decryption

```typescript
const { privateKey, publicKey } = x25519.keygen();     // per-request ephemeral

const access = await bkey.createAccessRequest({
  itemName: 'openai-api-key',
  fieldPath: 'value',
  purpose: 'Example agent',
  ephemeralPublicKey: Buffer.from(publicKey).toString('base64'),
});

const status = await pollAccessRequest(bkey, access.accessRequest.id);
const plaintext = decryptE2EE(status.e2eeCiphertext!, privateKey);
// `plaintext` is the stored value. Never persisted, never logged.
```

The `decryptE2EE` helper is 20 lines of Node `crypto` — inlined in `src/access.ts`. The same logic is used by the `bkey wrap` CLI command.

## Environment variables

| Variable | Description |
|---|---|
| `BKEY_CLIENT_ID` | OAuth client ID from `bkey auth setup-agent` |
| `BKEY_CLIENT_SECRET` | OAuth client secret |
| `BKEY_USER_DID` | BKey DID of the user whose approval is required |
| `BKEY_API_URL` | Optional. Defaults to `https://api.bkey.id`. |

## See also

- [Encryption guide](https://github.com/bkeyID/bkey/blob/main/docs/guides/encryption.mdx)
- [CIBA protocol](https://github.com/bkeyID/bkey/blob/main/docs/authentication/ciba.mdx)
- `bkey wrap` — the CLI equivalent (same decryption flow, injected as env vars)
