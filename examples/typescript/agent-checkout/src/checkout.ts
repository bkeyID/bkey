// copyright © 2025-2026 bkey inc. all rights reserved.

/**
 * TypeScript agent-checkout example.
 *
 * Shows both patterns side-by-side:
 *
 *   1. Generic one-line CIBA approval — `bkey.approve(...)` — the universal
 *      primitive for any sensitive action (deploy, refund, DB drop, admin
 *      grant, etc.). Returns an EdDSA-signed JWT proving user consent.
 *
 *   2. Structured checkout — `bkey.createCheckoutRequest(...)` +
 *      `pollCheckoutRequest(...)` — the same CIBA primitive with checkout-
 *      specific fields (merchant, items, amount) rendered on the phone.
 *
 * Run:
 *   npm run dev
 */

import 'dotenv/config';
import { BKey, pollCheckoutRequest } from '@bkey/sdk';

const BKEY_API_URL = process.env.BKEY_API_URL ?? 'https://api.bkey.id';
const BKEY_CLIENT_ID = process.env.BKEY_CLIENT_ID;
const BKEY_CLIENT_SECRET = process.env.BKEY_CLIENT_SECRET;
const BKEY_USER_DID = process.env.BKEY_USER_DID;

if (!BKEY_CLIENT_ID || !BKEY_CLIENT_SECRET || !BKEY_USER_DID) {
  console.error(
    'Missing credentials. Set BKEY_CLIENT_ID, BKEY_CLIENT_SECRET, ' +
      'BKEY_USER_DID in .env (copy from .env.example).',
  );
  process.exit(1);
}

const bkey = new BKey({
  apiUrl: BKEY_API_URL,
  clientId: BKEY_CLIENT_ID,
  clientSecret: BKEY_CLIENT_SECRET,
  did: BKEY_USER_DID,
});

async function demoGenericApproval(): Promise<void> {
  console.log('='.repeat(60));
  console.log('Part 1: Generic biometric approval');
  console.log('='.repeat(60));
  console.log('Check your phone — Face ID prompt incoming.\n');

  const result = await bkey.approve('Proceed with a test action', {
    scope: 'approve:action',
  });

  if (!result.approved) {
    console.log('Denied on device. Aborting.');
    process.exit(1);
  }

  console.log(`Approved. JWT prefix: ${result.accessToken.slice(0, 24)}...`);
  console.log('Verify this token server-side via /oauth/jwks before acting.\n');
}

async function demoCheckout(): Promise<void> {
  console.log('='.repeat(60));
  console.log('Part 2: Structured checkout');
  console.log('='.repeat(60));

  const created = (await bkey.createCheckoutRequest({
    merchantName: 'BKey Demo Store',
    merchantDomain: 'demo.bkey.id',
    checkoutUrl: 'https://demo.bkey.id/checkout/example',
    amount: 39.97,
    currency: 'USD',
    lineItems: [
      { title: 'Widget', quantity: 1, price: 9.99 },
      { title: 'Gadget', quantity: 2, price: 14.99 },
    ],
  })) as { checkoutRequest: { id: string } };

  const checkoutId = created.checkoutRequest.id;
  console.log(`Checkout created: ${checkoutId}`);
  console.log('Phone shows a shopping-cart-shaped approval screen.\n');

  const outcome = await pollCheckoutRequest(bkey, checkoutId, 180_000);
  console.log(`Checkout ${outcome.status}.`);
  if (outcome.orderConfirmation) {
    console.log('Order confirmation:', JSON.stringify(outcome.orderConfirmation, null, 2));
  }
}

async function main(): Promise<void> {
  try {
    await demoGenericApproval();
    await demoCheckout();
  } catch (err) {
    console.error('Example failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

void main();
