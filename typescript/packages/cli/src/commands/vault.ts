// copyright © 2025-2026 bkey inc. all rights reserved.

import { Command } from 'commander';
import { randomBytes, createCipheriv, createHash } from 'node:crypto';
import { x25519 } from '@noble/curves/ed25519';
import { createClient } from '../lib/config.js';
import { pollStoreRequest } from '@bkey/sdk';

export const vaultCommand = new Command('vault')
  .description('Manage vault items stored on your phone');

vaultCommand
  .command('store <name>')
  .description('Store a new vault item on your phone')
  .requiredOption('--type <type>', 'Item type: login, api_key, bearer_token, password, credit_card, note')
  .option('--field <fields...>', 'Field values as key=value pairs (e.g., --field key=sk-xxx)')
  .option('--description <desc>', 'Item description')
  .option('--tags <tags...>', 'Tags for the item')
  .option('--website <url>', 'Associated website URL')
  .option('--agent', 'Force agent mode')
  .option('--human', 'Force human mode (default)')
  .option('--profile <name>', 'Profile to use within the selected principal')
  .action(async (name: string, opts: {
    type: string;
    field?: string[];
    description?: string;
    tags?: string[];
    website?: string;
    agent?: boolean;
    human?: boolean;
    profile?: string;
  }) => {
    const api = createClient({ agent: opts.agent, human: opts.human, profile: opts.profile });

    // parse --field key=value pairs into a JSON object
    const fields: Record<string, string> = {};
    if (opts.field) {
      for (const f of opts.field) {
        const idx = f.indexOf('=');
        if (idx === -1) {
          console.error(`Invalid field format: "${f}". Use key=value.`);
          process.exit(1);
        }
        fields[f.slice(0, idx)] = f.slice(idx + 1);
      }
    }

    // fetch phone's vault X25519 public key for E2EE encryption
    let phonePublicKey: Buffer;
    try {
      const keyRes = await api.getVaultPublicKey();
      phonePublicKey = Buffer.from(keyRes.publicKey, 'base64');
      if (phonePublicKey.length !== 32) {
        throw new Error(`Invalid key length: ${phonePublicKey.length} (expected 32)`);
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('no encryption key') || msg.includes('not_found') || msg.includes('404')) {
        console.error(
          'No vault encryption key found. Open the vault in your BKey app first to generate one.',
        );
      } else {
        console.error(`Failed to fetch vault key: ${msg}`);
      }
      process.exit(1);
    }

    // E2EE: X25519 ECDH → AES-256-GCM (same pattern as access request E2EE)
    const ephemeralPrivateKey = x25519.utils.randomPrivateKey();
    const ephemeralPublicKey = x25519.getPublicKey(ephemeralPrivateKey);

    // shared secret = X25519(cliPriv, phonePub) → SHA256 → AES key
    const sharedSecret = x25519.getSharedSecret(ephemeralPrivateKey, phonePublicKey);
    const aesKey = createHash('sha256').update(sharedSecret).digest();

    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
    const plaintext = JSON.stringify(fields);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // pack: version (1) + ephemeralPub (32) + iv (12) + authTag (16) + ciphertext
    // version 0x02 = X25519 ECDH envelope (v1 was the legacy embedded transit key)
    // no transit key — backend cannot decrypt
    const encryptedPayload = Buffer.concat([
      Buffer.from([0x02]),
      Buffer.from(ephemeralPublicKey),
      iv,
      authTag,
      encrypted,
    ]).toString('base64');

    console.log(`Sending "${name}" (${opts.type}) to your phone for storage...`);

    try {
      const res = (await api.createStoreRequest({
        itemType: opts.type,
        name,
        description: opts.description,
        tags: opts.tags,
        website: opts.website,
        encryptedPayload,
      })) as { storeRequest: { id: string } };

      console.log('Waiting for approval on your phone...');
      await pollStoreRequest(api, res.storeRequest.id);

      console.log(`\nStored "${name}" on your device.`);
      console.log(`\nUse in proxy:`);
      console.log(`  bkey proxy GET <url> --header "Authorization: Bearer {vault:${name}}" --purpose "..."`);
    } catch (err) {
      console.error(`Failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

vaultCommand
  .command('list')
  .description('List vault items (metadata only)')
  .option('--type <type>', 'Filter by item type')
  .option('--agent', 'Force agent mode')
  .option('--human', 'Force human mode (default)')
  .option('--profile <name>', 'Profile to use within the selected principal')
  .action(async (opts: { type?: string; agent?: boolean; human?: boolean; profile?: string }) => {
    const api = createClient({ agent: opts.agent, human: opts.human, profile: opts.profile });

    try {
      const res = (await api.listVaultItems(opts.type)) as {
        items: Array<{
          name: string;
          itemType: string;
          description: string | null;
          fieldNames: string[];
          status: string;
          lastAccessedAt: string | null;
        }>;
      };

      if (res.items.length === 0) {
        console.log('No vault items found.');
        return;
      }

      console.log(`Found ${res.items.length} vault item(s):\n`);
      for (const item of res.items) {
        const desc = item.description ? ` — ${item.description}` : '';
        const fields = item.fieldNames.length > 0 ? ` [${item.fieldNames.join(', ')}]` : '';
        const accessed = item.lastAccessedAt ? ` (last accessed: ${item.lastAccessedAt})` : '';
        console.log(`  ${item.name} (${item.itemType})${fields}${desc}${accessed}`);
        console.log(`    bkey proxy <METHOD> <URL> --header "Authorization: Bearer {vault:${item.name}}" --purpose "..."`);
        console.log();
      }
    } catch (err) {
      console.error(`Failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

vaultCommand
  .command('delete <name>')
  .description('Archive a vault item')
  .action(async (name: string) => {
    console.log(`To delete vault items, use the BKey mobile app.`);
    console.log(`Item: ${name}`);
  });
