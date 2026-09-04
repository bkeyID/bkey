// copyright © 2025-2026 bkey inc. all rights reserved.

import { randomBytes, createCipheriv, createHash } from 'node:crypto';
import { x25519 } from '@noble/curves/ed25519.js';
import type { BKey } from '@bkey/sdk';
import { pollStoreRequest } from '@bkey/sdk';

/**
 * Encrypt a vault item's fields to the phone's registered X25519 vault key.
 *
 * X25519 ECDH with an ephemeral key → SHA-256 → AES-256-GCM. Envelope version
 * 0x02 (no transit key — the backend cannot decrypt). Shared by `bkey vault
 * store` and `bkey clients create|rotate-secret`, which push a freshly minted
 * client secret to the phone the same way.
 */
export function encryptVaultFields(
  fields: Record<string, string>,
  phonePublicKey: Buffer,
): string {
  if (phonePublicKey.length !== 32) {
    throw new Error(`Invalid vault key length: ${phonePublicKey.length} (expected 32)`);
  }
  // Any 32 random bytes are a valid X25519 secret (noble clamps internally);
  // generating them here keeps this independent of the @noble/curves major
  // (v1 `utils.randomPrivateKey` vs v2 `utils.randomSecretKey`).
  const ephemeralPrivateKey = new Uint8Array(randomBytes(32));
  const ephemeralPublicKey = x25519.getPublicKey(ephemeralPrivateKey);
  const sharedSecret = x25519.getSharedSecret(ephemeralPrivateKey, phonePublicKey);
  const aesKey = createHash('sha256').update(sharedSecret).digest();

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
  const plaintext = JSON.stringify(fields);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // pack: version (1) + ephemeralPub (32) + iv (12) + authTag (16) + ciphertext
  return Buffer.concat([
    Buffer.from([0x02]),
    Buffer.from(ephemeralPublicKey),
    iv,
    authTag,
    encrypted,
  ]).toString('base64');
}

/** Fetch the phone's vault public key, with the same guidance `vault store` prints. */
export async function fetchPhoneVaultKey(api: BKey): Promise<Buffer> {
  try {
    const keyRes = await api.getVaultPublicKey();
    const key = Buffer.from(keyRes.publicKey, 'base64');
    if (key.length !== 32) {
      throw new Error(`Invalid key length: ${key.length} (expected 32)`);
    }
    return key;
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('no encryption key') || msg.includes('not_found') || msg.includes('404')) {
      throw new Error(
        'No vault encryption key found. Open the vault in your BKey app first to generate one.',
      );
    }
    throw new Error(`Failed to fetch vault key: ${msg}`);
  }
}

export interface StoreOnPhoneInput {
  itemType: string;
  name: string;
  fields: Record<string, string>;
  description?: string;
  tags?: string[];
  website?: string;
}

/**
 * Encrypt `fields` to the phone and send a store request; resolves once the
 * user has approved on the phone and the item is stored. Throws on deny,
 * expiry, or timeout.
 */
export async function storeOnPhone(api: BKey, input: StoreOnPhoneInput): Promise<void> {
  const phoneKey = await fetchPhoneVaultKey(api);
  const encryptedPayload = encryptVaultFields(input.fields, phoneKey);
  const res = (await api.createStoreRequest({
    itemType: input.itemType,
    name: input.name,
    description: input.description,
    tags: input.tags,
    website: input.website,
    encryptedPayload,
  })) as { storeRequest: { id: string } };
  await pollStoreRequest(api, res.storeRequest.id);
}
