// copyright © 2025-2026 bkey inc. all rights reserved.

import { Command } from 'commander';
import { loadActiveHumanProfile, requireConfig } from '../lib/config.js';
import { BKey } from '@bkey/sdk';

export const approveCommand = new Command('approve')
  .description('Request biometric approval from a user via CIBA push notification')
  .argument('<message>', 'Binding message shown to the user (e.g. "Deploy to production")')
  .option('--scope <scope>', 'Approval scope', 'approve:action')
  .option('--user-did <did>', 'User DID to request approval from (falls back to the active human profile\'s saved DID)')
  .option('--amount <cents>', 'Amount in cents (for payment approvals)', parseInt)
  .option('--currency <code>', 'Currency code', 'USD')
  .option('--resource <name>', 'Resource being accessed')
  .option('--recipient <name>', 'Recipient of the action')
  .option('--description <text>', 'Action description')
  .option('--timeout <seconds>', 'Timeout in seconds', parseInt)
  .option('--profile <name>', 'Agent profile to use (default: saved default agent)')
  .option('--json', 'Output result as JSON')
  .action(async (message: string, opts: {
    scope: string;
    userDid?: string;
    amount?: number;
    currency: string;
    resource?: string;
    recipient?: string;
    description?: string;
    timeout?: number;
    profile?: string;
    json?: boolean;
  }) => {
    // approve is agent-only by nature — force the principal.
    const config = requireConfig({ principal: 'agent', profile: opts.profile });

    if (!config.clientId || !config.clientSecret) {
      console.error('approve requires agent mode (client_id + client_secret).');
      console.error('Set BKEY_CLIENT_ID + BKEY_CLIENT_SECRET env vars, or run: bkey auth setup-agent --save');
      process.exit(1);
    }

    const api = new BKey(config);
    const timeoutMs = (opts.timeout ?? 300) * 1000;

    // Target DID (who to ask) resolution: --user-did flag > active human profile DID > error.
    const savedDid = loadActiveHumanProfile()?.did;
    const userDid = opts.userDid ?? savedDid;
    if (!userDid) {
      console.error('No user DID specified.');
      console.error('Pass --user-did <did:bkey:...>, or run `bkey auth login` to save a default target.');
      process.exit(1);
    }

    // Build action details if any detail flags were provided
    const hasDetails = opts.amount != null || opts.resource || opts.recipient || opts.description;
    const actionDetails = hasDetails ? {
      type: opts.scope.replace('approve:', ''),
      description: opts.description ?? message,
      ...(opts.amount != null ? { amount: opts.amount, currency: opts.currency } : {}),
      ...(opts.resource ? { resource: opts.resource } : {}),
      ...(opts.recipient ? { recipient: opts.recipient } : {}),
    } : undefined;

    if (!opts.json) {
      console.log(`Requesting approval: "${message}"`);
      console.log('Waiting for approval on the user\'s phone (biometric approval required)...');
    }

    try {
      const result = await api.approve(message, {
        scope: opts.scope,
        actionDetails,
        userDid,
        timeoutMs,
      });

      if (opts.json) {
        console.log(JSON.stringify({
          approved: result.approved,
          access_token: result.accessToken,
          scope: result.scope,
          expires_in: result.expiresIn,
        }, null, 2));
      } else {
        const truncatedToken = result.accessToken.length > 20
          ? `${result.accessToken.slice(0, 16)}...${result.accessToken.slice(-4)}`
          : result.accessToken;
        console.log(`\nApproved!`);
        console.log(`  Token: ${truncatedToken}`);
        console.log(`  Scope: ${result.scope}`);
        console.log(`  Expires in: ${result.expiresIn}s`);
      }
    } catch (err) {
      const errMsg = (err as Error).message;
      if (opts.json) {
        console.log(JSON.stringify({ approved: false, error: errMsg }));
      } else {
        console.error(`Approval failed: ${errMsg}`);
      }
      process.exit(1);
    }
  });
