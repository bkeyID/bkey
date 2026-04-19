// copyright © 2025-2026 bkey inc. all rights reserved.

import { Command } from 'commander';
import { loadConfig, requireConfig } from '../lib/config.js';
import { BKey } from '@bkey/sdk';

export const approveCommand = new Command('approve')
  .description('Request biometric approval from a user via CIBA push notification')
  .argument('<message>', 'Binding message shown to the user (e.g. "Deploy to production")')
  .option('--scope <scope>', 'Approval scope', 'approve:action')
  .option('--user-did <did>', 'User DID to request approval from (falls back to saved session DID)')
  .option('--amount <cents>', 'Amount in cents (for payment approvals)', parseInt)
  .option('--currency <code>', 'Currency code', 'USD')
  .option('--resource <name>', 'Resource being accessed')
  .option('--recipient <name>', 'Recipient of the action')
  .option('--description <text>', 'Action description')
  .option('--timeout <seconds>', 'Timeout in seconds', parseInt)
  .option('--agent', 'Force agent mode (use ~/.bkey/agent.json); equivalent to BKEY_MODE=agent')
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
    agent?: boolean;
    json?: boolean;
  }) => {
    // approve is agent-only — default to agent mode so callers don't have to
    // remember to pass --agent every time. Humans can still use env overrides.
    const config = requireConfig({ agent: opts.agent ?? true });

    if (!config.clientId || !config.clientSecret) {
      console.error('approve requires agent mode (client_id + client_secret).');
      console.error('Set BKEY_CLIENT_ID + BKEY_CLIENT_SECRET env vars, or run: bkey auth setup-agent --save');
      process.exit(1);
    }

    const api = new BKey(config);
    const timeoutMs = (opts.timeout ?? 300) * 1000;

    // Target DID resolution (caller identity is separate — DID here is WHO to ask):
    //   1. --user-did flag (explicit)
    //   2. saved human session DID from ~/.bkey/config.json (self-approval for the
    //      developer who is both agent owner and approval target — common case)
    //   3. error
    const savedSessionDid = loadConfig()?.did;
    const userDid = opts.userDid ?? savedSessionDid;
    if (!userDid) {
      console.error('No user DID specified.');
      console.error('Pass --user-did <did:bkey:...>, or run `bkey auth login` to save your DID as the default target.');
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
