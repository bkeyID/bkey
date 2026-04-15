# BKey agent-checkout example (Python)

An agent-initiated purchase flow: a Python agent calls `checkout_request()`, BKey pushes a biometric approval to the user's phone, and the agent blocks until the user approves or rejects. On approval, the returned `payment_intent_id` is ready to hand to your payment processor.

Today, agents that spend money on behalf of a user either (a) hold long-lived credentials and hope nothing gets MitMed, or (b) surface a soft confirm dialog that anyone with the agent open can click through. This example replaces that with a **signed, biometrically bound, per-action** approval:

```
agent calls checkout_request(merchant, amount, items)
  └─> BKey pushes a prompt to the user's phone
        └─> user approves with facial biometrics
              └─> checkout_poll() unblocks with status=approved + payment_intent_id
                    └─> agent hands payment_intent_id to Stripe / etc.
```

Every purchase produces an auditable record: who approved, when, for what cart.

## Setup

This example installs `bkey-sdk` straight from PyPI — it's a standalone package you can copy out of the monorepo unchanged.

```bash
cd examples/python/agent-checkout
uv venv
uv pip install -e .
```

Create a `.env` file next to `pyproject.toml` (copy from `.env.example`) and fill in:

| Variable | Where to get it |
|---|---|
| `BKEY_CLIENT_ID` / `BKEY_CLIENT_SECRET` | Register an **agent client** at [bkey.id](https://bkey.id) (agent clients use the `client_credentials` grant). |
| `BKEY_API_URL` | Defaults to `https://api.bkey.id`. Override for staging or a local dev API. |

Then source the env and run the CLI:

```bash
set -a; source .env; set +a
uv run bkey-agent-checkout \
  --merchant "Acme Coffee" \
  --item "Latte:4.50:2" \
  --item "Croissant:3.25:1" \
  --currency USD
```

You'll see:

```
==> Requesting checkout: Acme Coffee — 12.25 USD
    checkout id: co_...
    approve on your phone …
==> approved
    payment_intent_id: pi_...
```

## How it works

Two calls, no magic:

1. **`checkout_request(merchant_name, items, amount, currency)`** → returns a `CheckoutResponse` with an `id`. BKey has already pushed the approval prompt to the user's phone at this point.
2. **`checkout_poll(checkout_id, timeout=120)`** → blocks until the user approves, rejects, or the server expires the request. On approval, returns a `CheckoutResult` with the `payment_intent_id` you can use to charge.

Errors surface as typed exceptions:

- `ApprovalDeniedError` — user hit reject on their phone.
- `ApprovalTimeoutError` — user didn't respond within `timeout`.
- `APIError` — the API returned an error (auth, quota, malformed request).

## Extending this

- **Bind the approval to the exact cart.** The user sees the merchant name and total on the phone. Pass them faithfully — don't let the agent describe a $5 order and charge $500.
- **Record the `payment_intent_id`.** It's the receipt — store it alongside the user's order so the charge is attributable.
- **One checkout per action.** Don't reuse an approved checkout for a different cart. If the cart changes, re-request approval.
- **Multi-user.** This example uses an agent client with a default user DID on the BKey side. For a shared agent, resolve the DID from your session (user login, OAuth, etc.) and register per-user agent clients.

## References

- [`bkey-sdk` on PyPI](https://pypi.org/project/bkey-sdk/) — `BKeyClient` source of truth
- [CIBA (OpenID Connect)](https://openid.net/specs/openid-client-initiated-backchannel-authentication-core-1_0.html) — the underlying approval protocol
- `../vault-access` — the companion example for secret retrieval
