# BKey agent checkout example

An AI agent that assembles a cart and initiates a merchant checkout — but **cannot spend money on its own**. The actual charge pauses on BKey until the human biometrically approves it on their phone.

```
agent builds cart
  └─> bkey.createCheckoutRequest({ merchant, amount, lineItems, ... })
        └─> push to user's phone
              └─> user sees merchant name + total + line items
                    └─> facial biometric approval
                          └─> BKey finalizes the checkout with the merchant
                                └─> agent polls status → order confirmation
```

The agent never sees a card number, a billing address, or a saved payment method. All of that lives in BKey (or at the merchant, behind the user's account). The agent's only capability is to **propose** a purchase; only a human with the phone + biometric can **authorize** one.

## What this example does

1. Builds a fixed cart — two bags of coffee and a dripper — so you can run it end-to-end without a merchant integration.
2. Calls `bkey.createCheckoutRequest()` with the cart + merchant details.
3. Polls `bkey.getCheckoutRequestStatus(id)` every 2 seconds, up to 300 seconds, until the status is terminal.
4. Prints the outcome:
   - **Approved + completed** → order-confirmation JSON goes to stdout.
   - **Rejected / expired / payment_failed** → exit code 3, reason on stderr.
   - **Timeout** → exit code 2, hint on stderr.

Logs go to stderr; only the final JSON goes to stdout. Pipe it into `jq` or hand it back to the agent.

## Setup

Installs `@bkey/sdk` straight from npm — the example is a standalone package, copy it out of the monorepo and it still works.

```bash
cd examples/typescript/agent-checkout
npm install
npm run build
```

Copy `.env.example` to `.env` and fill in:

| Variable | Where to get it |
|---|---|
| `BKEY_CLIENT_ID` / `BKEY_CLIENT_SECRET` | Register an **agent client** at [bkey.id](https://bkey.id) — agent clients use the OAuth `client_credentials` grant. |
| `BKEY_USER_DID` | The user who will get the approval push. In the BKey mobile app: Settings → Developer → Copy DID. |
| `MERCHANT_NAME` / `MERCHANT_DOMAIN` / `MERCHANT_CHECKOUT_URL` | The merchant identity shown on the user's phone. In production these come from your merchant integration; the defaults in `.env.example` are placeholders. |

Run it (Node 20+ has native `--env-file`, no dotenv needed):

```bash
node --env-file=.env dist/index.js
```

Your phone buzzes. Approve with facial biometrics. The script prints the order confirmation.

## Smoke test

Running without env vars should exit cleanly with a config error rather than a stack trace:

```bash
$ node dist/index.js
[bkey-checkout] BKEY_CLIENT_ID is required. Copy .env.example to .env and fill it in, then run with `node --env-file=.env dist/index.js`.
$ echo $?
1
```

## Adapting this to a real merchant

The fixed cart in `src/index.ts` is a stand-in. A real integration looks like:

1. **Your agent** (LLM, workflow, whatever) figures out what the user wants — via catalog search, browsing, a chat loop, etc. Build the `lineItems` + `amount` from that.
2. **Merchant integration.** `merchantName` and `merchantDomain` are what the user sees on their phone — they MUST match the real merchant. `checkoutUrl` is where BKey hands control back after approval; the merchant finalizes the charge against the user's saved payment method there.
3. **Reconcile on your side.** The `orderConfirmation` field in the approved status is whatever the merchant returned (order number, tracking, etc.). Surface this to the user, log it, and use it to close out the agent's task.

BKey-native merchants (like the Shopify/WooCommerce demo plugins in this repo) get `orderConfirmation` populated automatically. For custom merchants you own both sides of — pair this with your own checkout endpoint and return the order metadata you want to show.

## Design rules

**Bind the approval to the exact transaction.** `merchantName`, `amount`, `currency`, and `lineItems` all go into the prompt the user sees on their phone. Never send an approval request with "cart subtotal" and mutate the cart behind the user's back — the user consents to *this* cart, not "whatever the agent has in memory five minutes from now."

**Keep `expiresInSecs` tight.** 300 seconds (5 minutes) is the default. Approvals are per-transaction, not per-session — if the user walks away, the checkout should expire, not sit open indefinitely.

**Treat the checkout ID as single-use.** One approval → one order. The example polls a single checkout ID to completion; don't recycle checkout IDs across attempts.

**Never expose `BKEY_CLIENT_SECRET` to the agent.** The agent client credentials live on the server side of your agent runtime. The LLM / tool-calling layer should talk to your server, which holds the secret and calls BKey — not the other way around. If your agent runs untrusted code, the secret must not be reachable from that code.

**The agent proposes, the human authorizes.** This is the whole point. The agent never gets a payment token, never stores card details, never "saves" itself the trouble of asking. Every charge is biometrically signed by the human on device.

## References

- [`@bkey/sdk` on npm](https://www.npmjs.com/package/@bkey/sdk) — `createCheckoutRequest` / `getCheckoutRequestStatus` source of truth
- [Agent checkout guide](../../../docs/guides/agent-checkout.mdx) — positioning + sequence diagram + design rules
- [MCP auth gate example](../mcp-server/README.md) — the sibling pattern for gating MCP tool calls on biometric approval
- [CIBA (OpenID)](https://openid.net/specs/openid-client-initiated-backchannel-authentication-core-1_0.html) — the underlying push-to-phone protocol
