// copyright © 2025-2026 bkey inc. all rights reserved.

/**
 * TypeScript vault-access example.
 *
 * Shows both patterns side-by-side:
 *
 *   1. Generic one-line CIBA approval — `bkey.approve(...)` returns an
 *      EdDSA-signed JWT after the user approves on their phone.
 *
 *   2. End-to-end encrypted vault access — ephemeral X25519 keypair,
 *      phone encrypts with X25519 ECDH + AES-256-GCM, you decrypt locally.
 *      The backend never sees plaintext.
 *
 * See docs/guides/encryption.mdx for the full envelope layout.
 *
 * Run:
 *   npm run dev
 */

import 'dotenv/config';
import { createDecipheriv, createHash } from 'node:crypto';
import { BKey, pollAccessRequest } from '@bkey/sdk';
import { x25519 } from '@noble/curves/ed25519';

const BKEY_API_URL = process.env.BKEY_API_URL ?? 'https://api.bkey.id';
const BKEY_CLIENT_ID = process.env.BKEY_CLIENT_ID;
const BKEY_CLIENT_SECRET = process.env.BKEY_CLIENT_SECRET;
const BKEY_USER_DID = process.env.BKEY_USER_DID;
const ITEM_NAME = process.env.VAULT_ITEM_NAME ?? 'openai-api-key';

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

/**
 * Decrypt the E2EE ciphertext returned by the phone.
 *
 * Envelope layout (base64-decoded):
 *   phonePubKey (32 bytes) || iv (12 bytes) || authTag (16 bytes) || ciphertext
 *
 * Derivation:
 *   sharedSecret = X25519(ourEphemeralPriv, phonePubKey)
 *   aesKey       = SHA-256(sharedSecret)
 *   plaintext    = AES-256-GCM_decrypt(aesKey, iv, ciphertext, authTag)
 */
function decryptE2EE(e2eeCiphertext: string, ephemeralPrivateKey: Uint8Array): string {
  const buf = Buffer.from(e2eeCiphertext, 'base64');
  const phonePubKey = buf.subarray(0, 32);
  const iv = buf.subarray(32, 44);
  const authTag = buf.subarray(44, 60);
  const ciphertext = buf.subarray(60);

  const sharedSecret = x25519.getSharedSecret(ephemeralPrivateKey, phonePubKey);
  const aesKey = createHash('sha256').update(sharedSecret).digest();

  const decipher = createDecipheriv('aes-256-gcm', aesKey, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

async function demoGenericApproval(): Promise<void> {
  console.log('='.repeat(60));
  console.log('Part 1: Generic biometric approval');
  console.log('='.repeat(60));
  console.log("Check your phone — Face ID prompt incoming.\n");

  const result = await bkey.approve(`Read ${ITEM_NAME} for one API call`, {
    scope: 'approve:action',
  });

  if (!result.approved) {
    console.log('Denied on device. Aborting.');
    process.exit(1);
  }

  console.log(`Approved. JWT prefix: ${result.accessToken.slice(0, 24)}...\n`);
}

async function demoVaultAccess(): Promise<void> {
  console.log('='.repeat(60));
  console.log('Part 2: End-to-end encrypted vault access');
  console.log('='.repeat(60));

  // 1. Generate ephemeral X25519 keypair for this request.
  //    The private key never leaves this process.
  const ephemeralPrivateKey = x25519.utils.randomPrivateKey();
  const ephemeralPublicKey = x25519.getPublicKey(ephemeralPrivateKey);

  // 2. Create the access request.
  const access = (await bkey.createAccessRequest({
    itemName: ITEM_NAME,
    fieldPath: 'value',
    purpose: 'TypeScript example: one-shot API call',
    ephemeralPublicKey: Buffer.from(ephemeralPublicKey).toString('base64'),
  })) as { id: string };

  console.log(`Access request created: ${access.id}`);
  console.log("Approve on your phone. It'll show the item name + purpose.\n");

  // 3. Poll until approved / denied / timeout. The backend re-forwards the
  //    phone-produced ciphertext; it can't read it.
  const status = await pollAccessRequest(bkey, access.id, 120_000);

  if (!status.e2eeCiphertext) {
    console.error('Approved but no ciphertext returned. Status:', status.status);
    process.exit(1);
  }

  // 4. Decrypt locally with our ephemeral private key.
  const plaintext = decryptE2EE(status.e2eeCiphertext, ephemeralPrivateKey);

  console.log('Decrypted successfully:');
  console.log(`  prefix: ${plaintext.slice(0, 6)}...`);
  console.log(`  length: ${plaintext.length} chars`);
  console.log('\nUse `plaintext` in-memory; do not log or persist it.');
}

async function main(): Promise<void> {
  try {
    await demoGenericApproval();
    await demoVaultAccess();
  } catch (err) {
    console.error('Example failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

void main();
