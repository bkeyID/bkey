// copyright © 2025-2026 bkey inc. all rights reserved.

/**
 * BKey vault-access example.
 *
 * Two subcommands:
 *
 *   store <name> <value>
 *     Sends an end-to-end encrypted store request to the user's phone.
 *     The server never sees plaintext — the secret is encrypted
 *     client-side against the vault's public key and only the phone
 *     can unseal it during the biometric approval.
 *
 *   access <name>
 *     Generates a fresh ephemeral X25519 keypair, asks the user's phone
 *     to release the named item sealed to that public key, polls until
 *     approved, and decrypts the sealed ciphertext locally.
 *
 * Both flows block until the user approves or denies on device.
 * Stdout is reserved for the retrieved plaintext on `access`; all
 * progress logging goes to stderr so this composes cleanly with shell
 * redirection (`bkey-vault-example access openai > .env`).
 */

import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { x25519 } from '@noble/curves/ed25519';
import { BKey, pollAccessRequest, pollStoreRequest } from '@bkey/sdk';

// ── Config from env ──────────────────────────────────────────────────

const BKEY_API_URL = process.env.BKEY_API_URL ?? 'https://api.bkey.id';
const BKEY_CLIENT_ID = process.env.BKEY_CLIENT_ID;
const BKEY_CLIENT_SECRET = process.env.BKEY_CLIENT_SECRET;
const BKEY_USER_DID = process.env.BKEY_USER_DID;

// Field name this example reads and writes. Matches the default used by
// `bkey proxy` and `bkey wrap`, so values stored here interoperate with
// the main CLI's `{vault:<name>}` placeholder syntax.
const FIELD_NAME = 'key';

// Default approval expiry — tight enough that a stolen terminal can't
// sit on a pending prompt, long enough for a human to reach their phone.
const APPROVAL_EXPIRY_SECS = 300;

// ── CLI entry ────────────────────────────────────────────────────────

function usage(): never {
  process.stderr.write(
    [
      'bkey-vault-example — store/retrieve E2EE secrets via BKey',
      '',
      'Usage:',
      '  bkey-vault-example store <name> <value> [--purpose <text>]',
      '  bkey-vault-example access <name> [--purpose <text>]',
      '',
      'Env vars (see .env.example):',
      '  BKEY_API_URL        Defaults to https://api.bkey.id',
      '  BKEY_CLIENT_ID      OAuth client id (agent client)',
      '  BKEY_CLIENT_SECRET  OAuth client secret',
      '  BKEY_USER_DID       did:bkey:... of the vault owner',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

function parsePurpose(argv: string[], fallback: string): string {
  const idx = argv.indexOf('--purpose');
  if (idx === -1) return fallback;
  const value = argv[idx + 1];
  if (!value) {
    process.stderr.write('Error: --purpose requires a value.\n');
    process.exit(1);
  }
  return value;
}

async function main() {
  const [, , cmd, ...rest] = process.argv;

  if (!cmd || cmd === '-h' || cmd === '--help') usage();

  if (!BKEY_CLIENT_ID || !BKEY_CLIENT_SECRET) {
    process.stderr.write(
      '[bkey-vault] BKEY_CLIENT_ID and BKEY_CLIENT_SECRET are required. See .env.example.\n',
    );
    process.exit(1);
  }
  if (!BKEY_USER_DID) {
    process.stderr.write(
      '[bkey-vault] BKEY_USER_DID is required — it identifies the vault owner whose ' +
        'phone will receive the biometric approval prompt. See .env.example.\n',
    );
    process.exit(1);
  }

  const bkey = new BKey({
    apiUrl: BKEY_API_URL,
    clientId: BKEY_CLIENT_ID,
    clientSecret: BKEY_CLIENT_SECRET,
    did: BKEY_USER_DID,
  });

  switch (cmd) {
    case 'store': {
      const [name, value, ...flags] = rest;
      if (!name || !value) {
        process.stderr.write('Error: store requires <name> <value>.\n\n');
        usage();
      }
      const purpose = parsePurpose(flags, `Store ${name} via vault-access example`);
      await runStore(bkey, name, value, purpose);
      return;
    }
    case 'access': {
      const [name, ...flags] = rest;
      if (!name) {
        process.stderr.write('Error: access requires <name>.\n\n');
        usage();
      }
      const purpose = parsePurpose(flags, `Retrieve ${name} via vault-access example`);
      await runAccess(bkey, name, purpose);
      return;
    }
    default:
      process.stderr.write(`Error: unknown command "${cmd}".\n\n`);
      usage();
  }
}

// ── Store: encrypt client-side, send to phone for confirmation ──────

async function runStore(
  bkey: BKey,
  name: string,
  value: string,
  _purpose: string,
): Promise<void> {
  // 1. Fetch the vault's X25519 public key. This is the *phone's* key —
  //    the server stores it but cannot derive the matching private key
  //    (that lives in the Secure Enclave / Keystore on the user's device).
  let phonePublicKey: Buffer;
  try {
    const { publicKey } = await bkey.getVaultPublicKey();
    phonePublicKey = Buffer.from(publicKey, 'base64');
    if (phonePublicKey.length !== 32) {
      throw new Error(`unexpected key length ${phonePublicKey.length} (want 32)`);
    }
  } catch (err) {
    const msg = (err as Error).message;
    process.stderr.write(
      msg.includes('not_found') || msg.includes('404') || msg.includes('no encryption key')
        ? 'No vault encryption key found. Open the vault in your BKey app first to generate one.\n'
        : `Failed to fetch vault key: ${msg}\n`,
    );
    process.exit(1);
  }

  // 2. Encrypt the secret to the vault's public key using an X25519 ECDH
  //    envelope + AES-256-GCM. The ephemeral keypair is thrown away after
  //    this single encryption — the sealed payload can only be opened by
  //    whoever holds the vault's private key (the user's phone).
  const ephemeralPrivateKey = x25519.utils.randomPrivateKey();
  const ephemeralPublicKey = x25519.getPublicKey(ephemeralPrivateKey);

  const sharedSecret = x25519.getSharedSecret(ephemeralPrivateKey, phonePublicKey);
  const aesKey = createHash('sha256').update(sharedSecret).digest();

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
  const plaintext = JSON.stringify({ [FIELD_NAME]: value });
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Envelope: version(1) || ephemeralPub(32) || iv(12) || authTag(16) || ciphertext.
  // Version 0x02 signals the X25519-ECDH envelope format.
  const encryptedPayload = Buffer.concat([
    Buffer.from([0x02]),
    Buffer.from(ephemeralPublicKey),
    iv,
    authTag,
    ciphertext,
  ]).toString('base64');

  // 3. Send the sealed payload to the phone for confirmation. The server
  //    relays the ciphertext untouched; the phone decrypts, shows the
  //    user the field names it would store, and blocks on biometric
  //    confirmation before writing to its encrypted store.
  process.stderr.write(`Sending "${name}" to your phone for storage…\n`);

  let storeReqId: string;
  try {
    const res = (await bkey.createStoreRequest({
      itemType: 'api_key',
      name,
      encryptedPayload,
      expiresInSecs: APPROVAL_EXPIRY_SECS,
    })) as { storeRequest: { id: string } };
    storeReqId = res.storeRequest.id;
  } catch (err) {
    process.stderr.write(`Failed to create store request: ${(err as Error).message}\n`);
    process.exit(1);
  }

  process.stderr.write('Waiting for approval on your phone…\n');

  try {
    await pollStoreRequest(bkey, storeReqId);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  }

  process.stderr.write(`Stored "${name}" on your device.\n`);
}

// ── Access: ephemeral keypair, ask phone to seal to it, decrypt locally

async function runAccess(bkey: BKey, name: string, purpose: string): Promise<void> {
  // 1. Generate a fresh ephemeral X25519 keypair. The private key never
  //    leaves this process, and we generate a new pair for every access —
  //    even two requests for the same item must not share keys, so a
  //    stolen past ciphertext cannot be retroactively decrypted.
  const ephemeralPrivateKey = x25519.utils.randomPrivateKey();
  const ephemeralPublicKey = x25519.getPublicKey(ephemeralPrivateKey);

  // 2. Ask the phone to release the named item, sealed to our ephemeral
  //    public key. The user sees `purpose` on their phone — make it
  //    descriptive enough that they can decide whether to approve.
  process.stderr.write(`Requesting access to "${name}"… `);

  let requestId: string;
  try {
    const res = (await bkey.createAccessRequest({
      itemName: name,
      fieldPath: FIELD_NAME,
      purpose,
      ephemeralPublicKey: Buffer.from(ephemeralPublicKey).toString('base64'),
      expiresInSecs: APPROVAL_EXPIRY_SECS,
    })) as { id: string };
    requestId = res.id;
  } catch (err) {
    process.stderr.write(`\nFailed to create access request: ${(err as Error).message}\n`);
    process.exit(1);
  }

  process.stderr.write('waiting for approval on your phone…\n');

  // 3. Poll until the phone approves. On approval the response carries
  //    the ciphertext sealed to our ephemeral public key — the server
  //    stored it as a pass-through and still cannot read it.
  let sealed;
  try {
    sealed = await pollAccessRequest(bkey, requestId);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  }

  if (!sealed.e2eeCiphertext) {
    process.stderr.write('Approved, but no ciphertext returned.\n');
    process.exit(1);
  }

  // 4. Decrypt locally. The envelope the phone produces is:
  //    phonePub(32) || iv(12) || authTag(16) || ciphertext — no version
  //    byte (see @bkey/cli wrap for the canonical reference).
  const buf = Buffer.from(sealed.e2eeCiphertext, 'base64');
  const phonePub = buf.subarray(0, 32);
  const iv = buf.subarray(32, 44);
  const authTag = buf.subarray(44, 60);
  const ciphertext = buf.subarray(60);

  const sharedSecret = x25519.getSharedSecret(ephemeralPrivateKey, phonePub);
  const aesKey = createHash('sha256').update(sharedSecret).digest();

  const decipher = createDecipheriv('aes-256-gcm', aesKey, iv);
  decipher.setAuthTag(authTag);
  let plaintext: string;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (err) {
    process.stderr.write(`Decryption failed: ${(err as Error).message}\n`);
    process.exit(1);
  }

  // The payload is a JSON object keyed by field name.
  let fields: Record<string, string>;
  try {
    fields = JSON.parse(plaintext) as Record<string, string>;
  } catch {
    // Fallback: the phone may return the raw field value when a single
    // fieldPath is requested. In that case `plaintext` *is* the secret.
    process.stdout.write(`${plaintext}\n`);
    return;
  }

  const value = fields[FIELD_NAME];
  if (typeof value !== 'string') {
    process.stderr.write(
      `Expected field "${FIELD_NAME}" in released payload but found keys: ` +
        `${Object.keys(fields).join(', ') || '(none)'}\n`,
    );
    process.exit(1);
  }

  process.stdout.write(`${value}\n`);
}

main().catch((err) => {
  process.stderr.write(`Unhandled error: ${(err as Error).message}\n`);
  process.exit(1);
});
