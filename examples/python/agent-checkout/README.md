# Python agent-checkout example

End-to-end example of a Python agent that initiates a checkout and waits for the user to approve it biometrically on their phone.

Also shows the **generic one-line CIBA approval** pattern — the same pattern you'd use to gate a deploy, refund, admin action, or any sensitive operation.

## What you'll see

1. **Generic approval** — `client.approve("Deploy to prod", user_did=..., scope="approve:deploy")` — one call, biometric-gated, returns a signed JWT.
2. **Structured checkout** — `client.checkout_request(...)` → `client.checkout_poll(...)` — same CIBA primitive, with checkout-specific fields rendered on the user's phone (merchant, items, amount).

## Quickstart

```bash
# 1. Clone and enter the example
cd examples/python/agent-checkout

# 2. Create your agent credentials (once)
npm install -g @bkey/cli
bkey auth login                     # QR-code device auth
bkey auth setup-agent --name "Checkout Demo" --save

# 3. Install the SDK
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# 4. Configure
cp .env.example .env
# Edit .env: BKEY_CLIENT_ID, BKEY_CLIENT_SECRET, BKEY_USER_DID

# 5. Run
python checkout.py
```

You'll see a push notification on the phone associated with `BKEY_USER_DID`. Approve with Face ID. The script prints the approved checkout's payment intent.

## How the code works

### Part 1 — Generic one-line approval

```python
result = client.approve(
    message="Proceed with test action",
    user_did=BKEY_USER_DID,
    scope="approve:action",
)
```

That's it. One call:
- Initiates a CIBA request at `POST /oauth/bc-authorize`
- Sends the push notification to `BKEY_USER_DID`
- Polls `POST /oauth/token` until the user approves or denies
- Returns a `CIBAResult` with `access_token` — an EdDSA-signed JWT

You get back a short-lived, scoped proof of consent. Verify it server-side before acting on it (see `verify_token.py` in a real production app — the raw HTTP verification is straightforward against the `/oauth/jwks` endpoint).

### Part 2 — Checkout

`checkout_request()` is a thin wrapper around the same CIBA primitive. It adds merchant name, line items, amount, and currency to the approval screen so the user sees a shopping-cart-shaped prompt, not a plain text approval.

```python
checkout = client.checkout_request(
    merchant_name="BKey Demo Store",
    items=[{"name": "Widget", "price": 9.99, "quantity": 1}],
    amount=9.99,
    currency="USD",
)
result = client.checkout_poll(checkout.id)
if result.status == "completed":
    print(f"Payment intent: {result.payment_intent_id}")
```

## Why use `approve()` vs. `checkout_request()`?

- **`checkout_request()`** — use when the action is a purchase. The approval screen shows merchant + items + amount. BKey wires up payment processing downstream.
- **`approve()`** — use for anything else. Deploy, refund, DB migration, admin grant, agent handoff. You pick the scope and binding message. The signed JWT is your proof.

Both produce an auditable, cryptographically-bound record of user consent.

## Environment variables

| Variable | Description |
|---|---|
| `BKEY_CLIENT_ID` | OAuth client ID from `bkey auth setup-agent` |
| `BKEY_CLIENT_SECRET` | OAuth client secret from the same command |
| `BKEY_USER_DID` | The BKey DID of the user whose approval is required. From the BKey mobile app → Settings → Developer → Copy DID. |
| `BKEY_API_URL` | Optional. Defaults to `https://api.bkey.id`. |

## See also

- [CIBA protocol](https://github.com/bkeyID/bkey/blob/main/docs/authentication/ciba.mdx)
- [Encryption guide](https://github.com/bkeyID/bkey/blob/main/docs/guides/encryption.mdx) — what encryption protects each step
- [Python SDK reference](https://bkeyid.github.io/bkey/sdk/python/)
