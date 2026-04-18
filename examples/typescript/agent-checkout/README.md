# TypeScript agent-checkout example

End-to-end example of a Node.js agent that initiates a checkout and waits for the user to approve it biometrically on their phone.

Also shows the **generic one-line CIBA approval** pattern — the universal way to gate any sensitive action (deploy, refund, admin grant, DB drop, etc.) from your server.

## What you'll see

1. **Generic approval** — `bkey.approve("Do thing", { scope })` — one call, biometric-gated, returns an EdDSA JWT.
2. **Structured checkout** — `bkey.createCheckoutRequest(...)` → `pollCheckoutRequest(...)` — same CIBA primitive, with checkout-specific fields (merchant, items, amount) rendered on the user's phone.

## Quickstart

```bash
# 1. Install the CLI + this example
npm install -g @bkey/cli

cd examples/typescript/agent-checkout
npm install

# 2. Create agent credentials (once)
bkey auth login
bkey auth setup-agent --name "Checkout Demo" --save

# 3. Configure
cp .env.example .env
# Edit .env: BKEY_CLIENT_ID, BKEY_CLIENT_SECRET, BKEY_USER_DID

# 4. Run
npm run dev
```

You'll see a push notification on the phone associated with `BKEY_USER_DID`. Approve with Face ID.

## How the code works

### Part 1 — Generic one-line approval

```typescript
import { BKey } from '@bkey/sdk';

const bkey = new BKey({ apiUrl, clientId, clientSecret, did: userDid });

const result = await bkey.approve('Proceed with a test action', {
  scope: 'approve:action',
});

if (result.approved) {
  // result.accessToken is an EdDSA JWT — verify server-side before acting.
}
```

That single call hides the full CIBA protocol: it initiates the request, sends the push, polls until decided, and returns. Use it anywhere you need "yes from the human."

### Part 2 — Checkout

```typescript
const checkout = await bkey.createCheckoutRequest({
  merchantName: 'BKey Demo Store',
  items: [{ name: 'Widget', price: 9.99, quantity: 1 }],
  amount: 9.99,
  currency: 'USD',
});

const result = await pollCheckoutRequest(bkey, checkout.checkoutRequest.id);
if (result.status === 'completed') {
  // result.paymentIntentId is ready for downstream processing
}
```

Same underlying CIBA primitive; the checkout endpoint renders a shopping-cart-shaped approval screen.

## When to use which

- **`createCheckoutRequest()`** — use when the action is a purchase. Approval screen shows merchant + items + total; payment is wired downstream.
- **`approve()`** — use for anything else. Deploy, refund, DB migration, admin grant, agent handoff. You pick the scope and the binding message.

Both produce a signed, auditable, replay-resistant record of user consent.

## Environment variables

| Variable | Description |
|---|---|
| `BKEY_CLIENT_ID` | OAuth client ID from `bkey auth setup-agent` |
| `BKEY_CLIENT_SECRET` | OAuth client secret |
| `BKEY_USER_DID` | BKey DID of the user whose approval is required |
| `BKEY_API_URL` | Optional. Defaults to `https://api.bkey.id`. |

## See also

- [CIBA protocol](https://github.com/bkeyID/bkey/blob/main/docs/authentication/ciba.mdx)
- [Encryption guide](https://github.com/bkeyID/bkey/blob/main/docs/guides/encryption.mdx)
- [`@bkey/sdk` on npm](https://www.npmjs.com/package/@bkey/sdk)
