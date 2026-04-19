// copyright © 2025-2026 bkey inc. all rights reserved.

import { Command } from 'commander';
import { loadActiveHumanProfile, requireConfig } from '../lib/config.js';
import { BKey, pollCheckoutRequest } from '@bkey/sdk';

export const checkoutCommand = new Command('checkout')
  .description('Agentic checkout — purchase items with biometric approval');

checkoutCommand
  .command('request')
  .description('Create a checkout request and wait for biometric approval + payment')
  .requiredOption('--url <checkoutUrl>', 'Shopify checkout / continue URL')
  .requiredOption('--merchant <name>', 'Merchant display name')
  .requiredOption('--domain <domain>', 'Merchant domain (e.g., cool-store.myshopify.com)')
  .requiredOption('--amount <cents>', 'Total amount in cents', parseInt)
  .option('--currency <code>', 'Currency code (default: USD)', 'USD')
  .option('--item <items...>', 'Line items as "title:qty:price_cents" (e.g., "Black Tee:1:2999")')
  .option('--timeout <seconds>', 'Timeout in seconds (default: 300)', parseInt)
  .option('--purpose <text>', 'Purpose / reason for purchase')
  .option('--user-did <did>', 'User DID for CIBA approval (falls back to active human profile)')
  .option('--agent', 'Force agent mode')
  .option('--human', 'Force human mode (default)')
  .option('--profile <name>', 'Profile to use within the selected principal')
  .action(async (opts: {
    url: string;
    merchant: string;
    domain: string;
    amount: number;
    currency: string;
    item?: string[];
    timeout?: number;
    purpose?: string;
    userDid?: string;
    agent?: boolean;
    human?: boolean;
    profile?: string;
  }) => {
    const config = requireConfig({ agent: opts.agent, human: opts.human, profile: opts.profile });
    const api = new BKey(config);

    // parse --item "title:qty:price" into lineItems
    const lineItems: Array<{ title: string; quantity: number; price: number }> = [];
    if (opts.item) {
      for (const raw of opts.item) {
        const parts = raw.split(':');
        if (parts.length < 3) {
          console.error(`Invalid item format: "${raw}". Use "title:quantity:price_cents".`);
          process.exit(1);
        }
        const price = parseInt(parts[parts.length - 1]!, 10);
        const qty = parseInt(parts[parts.length - 2]!, 10);
        const title = parts.slice(0, parts.length - 2).join(':');
        lineItems.push({ title, quantity: qty, price });
      }
    } else {
      lineItems.push({ title: 'Purchase', quantity: 1, price: opts.amount });
    }

    const formattedAmount = (opts.amount / 100).toLocaleString('en-US', {
      style: 'currency',
      currency: opts.currency,
    });

    const isAgentMode = !!(config.clientId && config.clientSecret);
    const timeoutMs = (opts.timeout ?? 300) * 1000;

    try {
      if (isAgentMode) {
        // Target DID = --user-did > active human profile DID > error.
        const savedDid = loadActiveHumanProfile()?.did;
        const userDid = opts.userDid ?? savedDid;
        if (!userDid) {
          console.error('Agent mode requires --user-did or an active human profile.');
          console.error('Run `bkey auth login` to save a default target, or pass --user-did did:bkey:...');
          process.exit(1);
        }

        console.log(`Requesting payment approval via CIBA for ${formattedAmount} at ${opts.merchant}...`);
        console.log('User will receive a push notification to approve with facial biometrics.');

        const cibaRes = (await api.initiateCiba({
          login_hint: userDid,
          scope: 'approve:payment',
          binding_message: `${opts.merchant}: ${formattedAmount}`,
          action_details: {
            type: 'payment',
            description: `Purchase at ${opts.merchant}`,
            amount: opts.amount,
            currency: opts.currency,
            recipient: opts.domain,
          },
          requested_expiry: Math.min(Math.ceil(timeoutMs / 1000), 600),
        })) as { auth_req_id: string; expires_in: number; interval: number };

        // 2. Poll for CIBA approval token
        console.log('Waiting for approval on your phone (facial biometrics required)...');
        const cibaToken = await api.pollCibaToken(
          cibaRes.auth_req_id,
          (cibaRes.interval ?? 5) * 1000,
          timeoutMs,
        );

        // 3. Use the CIBA token to initiate checkout
        // With CIBA auto-approve, the backend creates the checkout as approved
        // and immediately triggers payment (SPT + PaymentIntent). The response
        // may already contain the payment result.
        const checkoutRes = (await api.requestWithToken('POST', '/v1/checkout/initiate', cibaToken.access_token, {
          merchantName: opts.merchant,
          merchantDomain: opts.domain,
          checkoutUrl: opts.url,
          amount: opts.amount,
          currency: opts.currency,
          lineItems,
        })) as { checkoutRequest: {
          id: string;
          status: string;
          expiresAt: string;
          sptId?: string;
          paymentIntentId?: string;
        } };

        const checkout = checkoutRes.checkoutRequest;
        const requestId = checkout.id;

        // Check if payment already completed during initiate (CIBA auto-approve)
        if (checkout.status === 'payment_processing' || checkout.status === 'payment_completed') {
          console.log(`Payment initiated (${checkout.status})`);
          if (checkout.paymentIntentId) console.log(`PaymentIntent: ${checkout.paymentIntentId}`);
          if (checkout.sptId) console.log(`SPT: ${checkout.sptId}`);

          // Poll briefly for webhook confirmation (payment_processing → payment_completed)
          if (checkout.status === 'payment_processing') {
            console.log('Waiting for payment confirmation...');
          }
          const result = await pollCheckoutRequest(api, requestId, timeoutMs);
          console.log(`\nCheckout ${result.status === 'payment_completed' ? 'payment completed!' : 'completed!'}`);
          if (result.orderConfirmation) {
            const conf = result.orderConfirmation;
            if (conf.paymentIntentId) console.log(`PaymentIntent: ${conf.paymentIntentId}`);
            if (conf.orderId) console.log(`Order ID: ${conf.orderId}`);
            console.log(`Status: ${conf.status ?? 'completed'}`);
          }
        } else {
          // Standard flow: poll for mobile approval + payment
          console.log(`Checkout request created: ${requestId}`);
          console.log('Waiting for payment completion...');

          const result = await pollCheckoutRequest(api, requestId, timeoutMs);
          console.log(`\nCheckout completed!`);
          if (result.orderConfirmation) {
            const conf = result.orderConfirmation;
            if (conf.orderId) console.log(`Order ID: ${conf.orderId}`);
            console.log(`Status: ${conf.status ?? 'completed'}`);
          }
          if (result.completedAt) console.log(`Completed at: ${result.completedAt}`);
        }
      } else {
        // ── Direct flow: user CLI with approve:payment scope ───────────
        console.log(`Requesting checkout approval for ${formattedAmount} at ${opts.merchant}...`);

        const res = (await api.createCheckoutRequest({
          merchantName: opts.merchant,
          merchantDomain: opts.domain,
          checkoutUrl: opts.url,
          amount: opts.amount,
          currency: opts.currency,
          lineItems,
        })) as { checkoutRequest: { id: string; expiresAt: string } };

        const requestId = res.checkoutRequest.id;
        console.log(`Checkout request created: ${requestId}`);
        console.log('Waiting for approval on your phone (facial biometrics required)...');

        const result = await pollCheckoutRequest(api, requestId, timeoutMs);

        console.log(`\nCheckout completed!`);
        if (result.orderConfirmation) {
          const conf = result.orderConfirmation;
          if (conf.orderId) console.log(`Order ID: ${conf.orderId}`);
          console.log(`Status: ${conf.status ?? 'completed'}`);
        }
        console.log(`Completed at: ${result.completedAt}`);
      }
    } catch (err) {
      console.error(`Checkout failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

checkoutCommand
  .command('status <requestId>')
  .description('Check the status of a checkout request')
  .option('--agent', 'Force agent mode')
  .option('--human', 'Force human mode (default)')
  .option('--profile <name>', 'Profile to use within the selected principal')
  .action(async (requestId: string, opts: { agent?: boolean; human?: boolean; profile?: string }) => {
    const config = requireConfig({ agent: opts.agent, human: opts.human, profile: opts.profile });
    const api = new BKey(config);

    try {
      const res = (await api.getCheckoutRequestStatus(requestId)) as {
        checkoutRequest: {
          id: string;
          status: string;
          orderConfirmation: Record<string, unknown> | null;
          approvedAt: string | null;
          completedAt: string | null;
          expiresAt: string;
        };
      };

      const req = res.checkoutRequest;
      console.log(`Checkout ${req.id}:`);
      console.log(`  Status: ${req.status}`);
      console.log(`  Expires: ${req.expiresAt}`);
      if (req.approvedAt) console.log(`  Approved: ${req.approvedAt}`);
      if (req.completedAt) console.log(`  Completed: ${req.completedAt}`);
      if (req.orderConfirmation) {
        console.log(`  Order: ${JSON.stringify(req.orderConfirmation)}`);
      }
    } catch (err) {
      console.error(`Failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });
