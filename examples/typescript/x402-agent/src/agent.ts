// copyright © 2025-2026 bkey inc. all rights reserved.

/**
 * x402 Agent Example
 *
 * Demonstrates an AI agent that automatically pays for API access using the
 * x402 protocol with BKey biometric approval.
 *
 * Flow:
 *   1. Agent requests a premium resource
 *   2. Server returns HTTP 402 with a PAYMENT-REQUIRED header
 *   3. Agent calls BKey to authorize the payment
 *   4. User approves on their phone with facial biometrics
 *   5. BKey returns a signed EIP-3009 payload (USDC on Base)
 *   6. Agent retries the request with the signed payload
 *   7. Server verifies and returns the resource
 *
 * Prerequisites:
 *   - BKey account with a funded USDC wallet on Base
 *   - Agent credentials (run `bkey auth setup-agent`)
 *   - Server running (npm run dev:server or any x402-protected endpoint)
 *
 * Usage:
 *   npm run dev
 */

import 'dotenv/config';
import { BKey } from '@bkey/sdk';

const BKEY_API_URL = process.env.BKEY_API_URL ?? 'https://api.bkey.id';
const BKEY_CLIENT_ID = process.env.BKEY_CLIENT_ID!;
const BKEY_CLIENT_SECRET = process.env.BKEY_CLIENT_SECRET!;
const TARGET_URL = process.env.TARGET_URL ?? 'http://localhost:3000/premium/joke';

if (!BKEY_CLIENT_ID || !BKEY_CLIENT_SECRET) {
  console.error('Set BKEY_CLIENT_ID and BKEY_CLIENT_SECRET in .env');
  console.error('Run: bkey auth setup-agent --save');
  process.exit(1);
}

const bkey = new BKey({
  apiUrl: BKEY_API_URL,
  clientId: BKEY_CLIENT_ID,
  clientSecret: BKEY_CLIENT_SECRET,
});

async function main() {
  console.log('=== BKey x402 Agent Demo ===\n');

  // Show the agent's wallet address
  try {
    const wallet = await bkey.getX402Wallet();
    console.log(`Wallet: ${wallet.address} (${wallet.asset} on ${wallet.network})`);
  } catch {
    console.log('Wallet: not yet configured\n');
  }

  // Step 1: Request the resource — expect a 402
  console.log(`Requesting: ${TARGET_URL}`);
  const response = await fetch(TARGET_URL);

  if (response.status !== 402) {
    const body = await response.json();
    console.log('Resource returned without payment:', body);
    return;
  }

  // Step 2: Decode the payment requirement
  const paymentHeader = response.headers.get('payment-required');
  if (!paymentHeader) {
    console.error('402 response missing PAYMENT-REQUIRED header');
    process.exit(1);
  }

  const paymentRequired = JSON.parse(
    Buffer.from(paymentHeader, 'base64').toString('utf-8'),
  );

  const amountUsdc = Number(paymentRequired.maxAmountRequired) / 1_000_000;
  console.log(`\nPayment required:`);
  console.log(`  Amount:  ${amountUsdc} USDC`);
  console.log(`  Pay to:  ${paymentRequired.payTo}`);
  console.log(`  For:     ${paymentRequired.description ?? TARGET_URL}\n`);

  // Step 3: Authorize the payment via BKey
  // BKey checks spending limits and either auto-approves or sends a push
  // notification to the user's phone for biometric approval.
  console.log('Submitting payment authorization to BKey...');
  const amountCents = Math.ceil(amountUsdc * 100);
  const chainId = parseInt(paymentRequired.network?.match(/(\d+)/)?.[1] ?? '8453', 10);

  const auth = await bkey.authorizeX402Payment({
    amountCents,
    recipientAddress: paymentRequired.payTo,
    chainId,
    description: paymentRequired.description,
    resource: paymentRequired.resource ?? TARGET_URL,
  });

  let signedPayload: string;

  if (auth.status === 'authorized' && auth.authorization) {
    // Auto-approved — payment was within the spending limit
    console.log('Auto-approved (within spending limit).\n');
    signedPayload = Buffer.from(JSON.stringify(auth.authorization)).toString('base64');
  } else if (auth.authorizationId) {
    // Biometric approval required
    console.log('Biometric approval required — check your phone.');
    console.log('Approve the payment using facial biometrics.\n');

    const signed = await bkey.pollX402Authorization(auth.authorizationId, {
      timeoutMs: 120_000,
    });
    signedPayload = signed.signedPayload!;
    console.log(`Signed by: ${signed.fromAddress}\n`);
  } else {
    console.error('Unexpected authorization response:', auth);
    process.exit(1);
  }

  // Step 4: Retry with the signed payload
  console.log('Retrying with payment...');
  const paidResponse = await fetch(TARGET_URL, {
    headers: { 'PAYMENT-SIGNATURE': signedPayload },
  });

  if (!paidResponse.ok) {
    console.error(`Payment rejected: ${paidResponse.status}`);
    process.exit(1);
  }

  const resource = await paidResponse.json();
  console.log('\n=== Resource unlocked ===');
  console.log(JSON.stringify(resource, null, 2));

  // Check for payment receipt
  const receipt = paidResponse.headers.get('payment-response');
  if (receipt) {
    const receiptData = JSON.parse(Buffer.from(receipt, 'base64').toString());
    console.log(`\nTransaction: ${receiptData.txHash ?? '(pending)'}`);
  }
}

main().catch((err) => {
  console.error('Agent error:', err.message);
  process.exit(1);
});
