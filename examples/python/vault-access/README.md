# BKey vault access example (Python)

Store a secret in BKey's vault, then retrieve it only after the owner biometrically approves on their phone — and decrypt the returned ciphertext locally, so the plaintext never sits in the server's memory on the return path.

```
store:   agent → BKey API → vault (encrypted at rest, bound to user's device key)
access:  agent → BKey API → push to user's phone
                              └─> user approves with facial biometrics
                                    └─> server encrypts secret to our ephemeral X25519 key
                                          └─> we decrypt locally with our private key
```

Two subcommands:

| Subcommand | What it does |
|---|---|
| `bkey-vault-access store <name> <value>` | Store a secret under `<name>`. |
| `bkey-vault-access access <name>` | Request access. Blocks on approval, then decrypts and prints. |

## Setup

This example installs `bkey-sdk` plus `pynacl` (for X25519) straight from PyPI.

```bash
cd examples/python/vault-access
uv venv
uv pip install -e .
```

Create a `.env` file next to `pyproject.toml` (copy from `.env.example`) and fill in:

| Variable | Where to get it |
|---|---|
| `BKEY_CLIENT_ID` / `BKEY_CLIENT_SECRET` | Register a client at [bkey.id](https://bkey.id). |
| `BKEY_API_URL` | Defaults to `https://api.bkey.id`. Override for staging or local dev. |

Then source the env and run:

```bash
set -a; source .env; set +a
uv run bkey-vault-access store stripe-test-key sk_test_1234...
uv run bkey-vault-access access stripe-test-key
```

On `access`, you'll see:

```
==> access requested: id=vault_...
    approve on your phone …
==> approved
sk_test_1234...
```

## How the E2EE handshake works

1. Before the access request, this script generates a fresh **ephemeral** X25519 keypair in memory.
2. The request sends only the **public** half (`ephemeralPublicKey`) to BKey.
3. BKey pushes an approval prompt to the owner's phone. The owner sees what they're approving and confirms with facial biometrics.
4. On approval, the server encrypts the secret to our ephemeral public key (NaCl box over X25519) and returns the ciphertext plus the server's ephemeral public key.
5. We decrypt locally using our private key, which never leaves this process.

A fresh keypair per access means a compromise of one session's private key cannot be used to decrypt ciphertext from any other session.

## Caveats

- **The Python SDK does not yet implement client-side encryption on `store`.** The value you pass is sent plaintext over TLS; the BKey API encrypts it server-side before writing to the vault. If you need end-to-end encryption at rest today, use [`@bkey/sdk`](https://www.npmjs.com/package/@bkey/sdk) or the `bkey` CLI to store; this Python example can still decrypt on `access`.
- **Keys are in-process only.** This script never persists the X25519 private key. If you want to support long-running agents that periodically re-access the same secret, you'll want to generate a new keypair per access (as this example does) — don't cache the private key.
- **One access per request.** The CIBA approval is bound to the specific `auth_req_id` and the ephemeral public key you send. Don't reuse ciphertext for a different key.

## Extending this

- **Scoped access policies.** Register clients with narrow scopes (`vault:read:stripe-keys`) rather than blanket vault access. The user's phone shows the scope.
- **Bind to action details.** If your app has a concept like "agent is about to deploy the `foo` service and needs the deploy token", pass that context in the approval request so the user sees it on their phone.
- **Audit the `jti`.** Every approval comes with a unique JWT id; log it alongside the secret retrieval so reads are traceable.

## References

- [`bkey-sdk` on PyPI](https://pypi.org/project/bkey-sdk/) — `BKeyClient.vault_store()` / `vault_access()` / `vault_poll()`
- [PyNaCl](https://pynacl.readthedocs.io/) — the X25519 / NaCl box primitives
- `../agent-checkout` — the companion example for agent-initiated purchases
