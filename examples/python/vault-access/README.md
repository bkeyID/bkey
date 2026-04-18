# Python vault-access example

End-to-end example of a Python program that reads an encrypted secret from the BKey vault — decrypted only after the user approves on their phone with Face ID — and uses it to make an authenticated API call.

Also shows the **generic one-line CIBA approval** pattern — the universal way to gate any sensitive action from Python.

## Two things this example demonstrates

1. **Generic biometric approval** — `client.approve(...)` — the same primitive you'd use for deploys, refunds, admin actions, DB writes, etc.
2. **Vault access** — how to pull an encrypted secret out of the BKey vault and use it in-process.

## Why the vault flow uses the CLI wrapper

Vault access is **end-to-end encrypted** between your process and the user's phone:

- Your process generates an ephemeral X25519 keypair per access request.
- The phone, after Face ID, does X25519 ECDH with your public key and encrypts the value with AES-256-GCM sealed to your ephemeral key.
- You decrypt locally; the backend never sees plaintext.

See the [encryption guide](https://github.com/bkeyID/bkey/blob/main/docs/guides/encryption.mdx) for the full envelope layout.

The BKey CLI already implements the X25519 + AES-256-GCM decryption (in `bkey wrap`), so the recommended pattern from Python is to **shell out to `bkey wrap`** and receive the decrypted value as an environment variable. This keeps your Python code tiny and the cryptography battle-tested in one place.

For pure-Python E2EE support, you'd add `cryptography` or `pynacl` and mirror the CLI's decrypt logic (X25519 ECDH → SHA-256 → AES-256-GCM, envelope format `phonePubKey(32) || iv(12) || authTag(16) || ciphertext`). See the `bkey wrap` source for reference.

## Quickstart

```bash
# 1. Install the CLI + SDK
npm install -g @bkey/cli

cd examples/python/vault-access
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# 2. Log in + create agent credentials (once)
bkey auth login
bkey auth setup-agent --name "Vault Demo" --save

# 3. Store a test secret (one-time; triggers a biometric on your phone)
bkey vault store openai-api-key --field value=sk-test-...

# 4. Configure
cp .env.example .env
# Edit .env: BKEY_CLIENT_ID, BKEY_CLIENT_SECRET, BKEY_USER_DID

# 5. Run
python access.py
```

You'll see two biometric prompts on the phone:
- First for the generic approval demo.
- Second for the vault access (decrypts the secret into this process).

## How the code works

### Part 1 — Generic one-line approval

```python
result = client.approve(
    message="Read OPENAI_API_KEY for a one-off request",
    user_did=BKEY_USER_DID,
    scope="approve:action",
)
# result.access_token is an EdDSA JWT proving the user said yes
```

### Part 2 — Vault access via `bkey wrap`

```python
result = subprocess.run(
    [
        "bkey", "wrap",
        "--env", f"OPENAI_API_KEY={{vault:{ITEM_NAME}}}",
        "--purpose", "Python example: read OpenAI key",
        "--",
        "python", "-c", "import os; print(os.environ['OPENAI_API_KEY'])",
    ],
    check=True,
)
```

What happens:

1. `bkey wrap` sees the `{vault:openai-api-key}` placeholder.
2. It creates a vault access request bound to an ephemeral X25519 key.
3. Phone gets a push notification, user approves with Face ID.
4. Phone encrypts the value under your ephemeral key; CLI decrypts in-memory.
5. CLI sets `OPENAI_API_KEY=sk-test-...` on the child process.
6. Your inner Python program reads `os.environ['OPENAI_API_KEY']`.
7. When the process exits, the value is gone. No disk, no logs.

## Environment variables

| Variable | Description |
|---|---|
| `BKEY_CLIENT_ID` | OAuth client ID from `bkey auth setup-agent` |
| `BKEY_CLIENT_SECRET` | OAuth client secret from the same command |
| `BKEY_USER_DID` | The BKey DID of the user whose approval is required |
| `BKEY_API_URL` | Optional. Defaults to `https://api.bkey.id`. |

## See also

- [Encryption guide](https://github.com/bkeyID/bkey/blob/main/docs/guides/encryption.mdx)
- [CIBA protocol](https://github.com/bkeyID/bkey/blob/main/docs/authentication/ciba.mdx)
- [CLI `vault` + `wrap` commands](https://github.com/bkeyID/bkey/blob/main/docs/sdk/cli.mdx)
- [Python SDK reference](https://bkeyid.github.io/bkey/sdk/python/)
