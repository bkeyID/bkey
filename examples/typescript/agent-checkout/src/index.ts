// copyright © 2025-2026 bkey inc. all rights reserved.

/**
 * BKey agent checkout example.
 *
 * Simulates an AI agent that assembles a cart on behalf of a user, then
 * hands the actual purchase off to BKey for biometric approval on the
 * user's phone. The agent never touches a card number; the human
 * approves (or rejects) the charge on device.
 *
 *   agent builds cart
 *     └─> bkey.createCheckoutRequest({...})
 *           └─> push notification to user's phone
 *                 └─> user reviews merchant + total + line items
 *                       └─> facial biometric approval
 *                             └─> BKey completes the merchant checkout
 *                                   └─> agent polls, prints order confirmation
 *
 * Logs go to stderr so stdout is clean for the final order confirmation
 * JSON — pipe into `jq` or a downstream tool if you like.
 */

import { BKey } from '@bkey/sdk';
import type { CheckoutRequestInput, CheckoutStatus } from '@bkey/sdk';

// ── Config from env ──────────────────────────────────────────────────

const BKEY_API_URL = process.env.BKEY_API_URL ?? 'https://api.bkey.id';
const BKEY_CLIENT_ID = process.env.BKEY_CLIENT_ID;
const BKEY_CLIENT_SECRET = process.env.BKEY_CLIENT_SECRET;
const BKEY_USER_DID = process.env.BKEY_USER_DID;
const MERCHANT_NAME = process.env.MERCHANT_NAME;
const MERCHANT_DOMAIN = process.env.MERCHANT_DOMAIN;
const MERCHANT_CHECKOUT_URL = process.env.MERCHANT_CHECKOUT_URL;

function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    console.error(
      `[bkey-checkout] ${name} is required. Copy .env.example to .env and ` +
        'fill it in, then run with `node --env-file=.env dist/index.js`.',
    );
    process.exit(1);
  }
  return value;
}

const clientId = requireEnv('BKEY_CLIENT_ID', BKEY_CLIENT_ID);
const clientSecret = requireEnv('BKEY_CLIENT_SECRET', BKEY_CLIENT_SECRET);
const userDid = requireEnv('BKEY_USER_DID', BKEY_USER_DID);
const merchantName = requireEnv('MERCHANT_NAME', MERCHANT_NAME);
const merchantDomain = requireEnv('MERCHANT_DOMAIN', MERCHANT_DOMAIN);
const merchantCheckoutUrl = requireEnv(
  'MERCHANT_CHECKOUT_URL',
  MERCHANT_CHECKOUT_URL,
);

// ── BKey client (agent mode: client credentials + user DID) ──────────

const bkey = new BKey({
  apiUrl: BKEY_API_URL,
  clientId,
  clientSecret,
  did: userDid,
});

// ── The "agent" — stand-in for whatever put the cart together ────────
//
// In a real deployment this is your agent reasoning over a product catalog,
// comparing prices, applying a coupon, etc. Here it's just a static cart
// so the example is runnable end-to-end without a merchant integration.

const lineItems = [
  { title: 'Ethiopia Yirgacheffe — 12oz whole bean', quantity: 2, price: 18.5 },
  { title: 'Ceramic pour-over dripper', quantity: 1, price: 32.0 },
];

const subtotal = lineItems.reduce(
  (sum, item) => sum + item.price * item.quantity,
  0,
);

// ── Build the checkout request ───────────────────────────────────────
//
// Everything in here is displayed to the user on their phone. The merchant
// identity + line items + total are the approval contract: the user
// consents to THIS transaction, not "whatever the agent buys next."

const checkoutInput: CheckoutRequestInput = {
  merchantName,
  merchantDomain,
  checkoutUrl: merchantCheckoutUrl,
  amount: Number(subtotal.toFixed(2)),
  currency: 'USD',
  lineItems,
  // Tight expiry — the user needs to respond while they remember asking
  // the agent to buy this. 5 minutes is plenty.
  expiresInSecs: 300,
};

// ── Initiate + poll ──────────────────────────────────────────────────

async function main(): Promise<void> {
  console.error(
    `[bkey-checkout] initiating checkout: ${merchantName} — ` +
      `$${checkoutInput.amount.toFixed(2)} ${checkoutInput.currency}`,
  );

  const initiated = (await bkey.createCheckoutRequest(checkoutInput)) as {
    id?: string;
    checkoutRequest?: { id: string };
  };

  // The API returns the new request either as `{ id, ... }` or wrapped as
  // `{ checkoutRequest: { id, ... } }` depending on the endpoint version —
  // accept either shape so the example keeps working across minor bumps.
  const checkoutId = initiated.id ?? initiated.checkoutRequest?.id;
  if (!checkoutId) {
    console.error(
      '[bkey-checkout] unexpected response from createCheckoutRequest:',
      initiated,
    );
    process.exit(1);
  }

  console.error(
    `[bkey-checkout] checkout ${checkoutId} created — waiting for ` +
      'biometric approval on phone (up to 300s)…',
  );

  const result = await pollForResult(checkoutId, 300_000, 2_000);

  if (result.kind === 'timeout') {
    console.error(
      `[bkey-checkout] timed out after ${Math.round(result.elapsedMs / 1000)}s ` +
        'with no response. Check the BKey mobile app for a missed push.',
    );
    process.exit(2);
  }

  if (result.kind === 'denied') {
    console.error(
      `[bkey-checkout] checkout ${result.reason}: user declined the ` +
        'charge on device.',
    );
    process.exit(3);
  }

  // Approved + completed. Print the order confirmation to stdout so
  // callers can pipe it into jq or feed it back into the agent loop.
  console.error(
    `[bkey-checkout] approved in ${Math.round(result.elapsedMs / 1000)}s ` +
      `(status=${result.status.status}).`,
  );

  process.stdout.write(
    JSON.stringify(
      {
        checkoutId: result.status.id,
        status: result.status.status,
        approvedAt: result.status.approvedAt,
        completedAt: result.status.completedAt,
        merchant: {
          name: merchantName,
          domain: merchantDomain,
        },
        amount: checkoutInput.amount,
        currency: checkoutInput.currency,
        orderConfirmation: result.status.orderConfirmation,
      },
      null,
      2,
    ) + '\n',
  );
}

type PollResult =
  | { kind: 'approved'; status: CheckoutStatus; elapsedMs: number }
  | { kind: 'denied'; reason: 'rejected' | 'expired' | 'payment_failed'; elapsedMs: number }
  | { kind: 'timeout'; elapsedMs: number };

async function pollForResult(
  checkoutId: string,
  timeoutMs: number,
  intervalMs: number,
): Promise<PollResult> {
  const start = Date.now();
  const deadline = start + timeoutMs;

  while (Date.now() < deadline) {
    const raw = (await bkey.getCheckoutRequestStatus(checkoutId)) as {
      checkoutRequest?: CheckoutStatus;
    } & Partial<CheckoutStatus>;
    const req: CheckoutStatus =
      (raw.checkoutRequest as CheckoutStatus | undefined) ??
      (raw as unknown as CheckoutStatus);

    if (req.status === 'completed' || req.status === 'payment_completed') {
      return { kind: 'approved', status: req, elapsedMs: Date.now() - start };
    }
    if (
      req.status === 'rejected' ||
      req.status === 'expired' ||
      req.status === 'payment_failed'
    ) {
      return {
        kind: 'denied',
        reason: req.status,
        elapsedMs: Date.now() - start,
      };
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  return { kind: 'timeout', elapsedMs: Date.now() - start };
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[bkey-checkout] error: ${msg}`);
  process.exit(1);
});
