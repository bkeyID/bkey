// copyright © 2025-2026 bkey inc. all rights reserved.

import { Command } from 'commander';
import { createDecipheriv, createHash } from 'node:crypto';
import { x25519 } from '@noble/curves/ed25519';
import { requireConfig } from '../lib/config.js';
import { BKey, pollAccessRequest } from '@bkey/sdk';

// ─── E2EE helpers ───────────────────────────────────────────────────────────

function generateEphemeralKeyPair(): { publicKey: Uint8Array; privateKey: Uint8Array } {
  const privateKey = x25519.utils.randomPrivateKey();
  const publicKey = x25519.getPublicKey(privateKey);
  return { publicKey, privateKey };
}

function decryptE2EE(e2eeCiphertext: string, ephemeralPrivateKey: Uint8Array): string {
  const buf = Buffer.from(e2eeCiphertext, 'base64');

  // format: phonePubKey(32) + iv(12) + authTag(16) + ciphertext
  const phonePubKey = buf.subarray(0, 32);
  const iv = buf.subarray(32, 44);
  const authTag = buf.subarray(44, 60);
  const ciphertext = buf.subarray(60);

  // X25519 ECDH → shared secret → SHA256 → AES key
  const sharedSecret = x25519.getSharedSecret(ephemeralPrivateKey, phonePubKey);
  const aesKey = createHash('sha256').update(sharedSecret).digest();

  const decipher = createDecipheriv('aes-256-gcm', aesKey, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  return decrypted.toString('utf8');
}

// ─── vault placeholder regex ────────────────────────────────────────────────

const VAULT_PLACEHOLDER = /\{vault:([a-zA-Z0-9_ -]+?)(?::([a-zA-Z0-9_-]+))?\}/g;

interface VaultRef {
  placeholder: string;
  itemName: string;
  fieldPath: string;
}

function parseVaultRefs(headers: string[]): VaultRef[] {
  const refs: VaultRef[] = [];
  const seen = new Set<string>();

  for (const h of headers) {
    let match;
    VAULT_PLACEHOLDER.lastIndex = 0;
    while ((match = VAULT_PLACEHOLDER.exec(h)) !== null) {
      const key = `${match[1]}:${match[2] ?? 'key'}`;
      if (!seen.has(key)) {
        seen.add(key);
        refs.push({
          placeholder: match[0],
          itemName: match[1],
          fieldPath: match[2] ?? 'key', // default to "key" field
        });
      }
    }
  }

  return refs;
}

// ─── proxy command ──────────────────────────────────────────────────────────

export const proxyCommand = new Command('proxy')
  .description('Make HTTP requests with vault secrets injected (agent never sees secrets)')
  .argument('<method>', 'HTTP method (GET, POST, PUT, DELETE, PATCH)')
  .argument('<url>', 'Target URL')
  .option('--header <headers...>', 'Headers with {vault:name} placeholders')
  .option('--data <body>', 'Request body (JSON string)')
  .option('--purpose <purpose>', 'Purpose description for approval notification', 'CLI proxy request')
  .option('--timeout <seconds>', 'Approval timeout in seconds', '120')
  .action(async (method: string, url: string, opts: {
    header?: string[];
    data?: string;
    purpose: string;
    timeout: string;
  }) => {
    const config = requireConfig();
    const api = new BKey(config);
    const headers = opts.header ?? [];

    // 1. Parse {vault:xxx} placeholders from headers
    const refs = parseVaultRefs(headers);

    if (refs.length === 0) {
      console.error('No {vault:...} placeholders found in headers. Use --header "Authorization: Bearer {vault:my-key}"');
      process.exit(1);
    }

    // 2. For each unique vault item, generate ephemeral key and request access
    const resolvedValues = new Map<string, string>();
    const parsedTimeout = parseInt(opts.timeout, 10);
    if (isNaN(parsedTimeout) || parsedTimeout <= 0) {
      console.error(`Invalid timeout: "${opts.timeout}". Must be a positive number of seconds.`);
      process.exit(1);
    }
    const timeoutMs = parsedTimeout * 1000;

    for (const ref of refs) {
      const { publicKey, privateKey } = generateEphemeralKeyPair();

      process.stderr.write(`Requesting access to "${ref.itemName}" (${ref.fieldPath})... `);

      try {
        const accessRes = (await api.createAccessRequest({
          itemName: ref.itemName,
          fieldPath: ref.fieldPath,
          purpose: opts.purpose,
          ephemeralPublicKey: Buffer.from(publicKey).toString('base64'),
        })) as { id: string };

        process.stderr.write('waiting for approval on your phone...\n');

        // 3. Poll until approved
        const status = await pollAccessRequest(api, accessRes.id, timeoutMs);

        if (!status.e2eeCiphertext) {
          throw new Error('No encrypted value returned from approval.');
        }

        // 4. Decrypt E2EE ciphertext
        const value = decryptE2EE(status.e2eeCiphertext, privateKey);
        resolvedValues.set(ref.placeholder, value);

        process.stderr.write(`Access to "${ref.itemName}" granted.\n`);
      } catch (err) {
        process.stderr.write(`\nFailed: ${(err as Error).message}\n`);
        process.exit(1);
      }
    }

    // 5. Substitute placeholders in headers
    const resolvedHeaders: Record<string, string> = {};
    for (const h of headers) {
      const colonIdx = h.indexOf(':');
      if (colonIdx === -1) {
        console.error(`Invalid header format: "${h}". Use "Name: Value".`);
        process.exit(1);
      }
      const name = h.slice(0, colonIdx).trim();
      let value = h.slice(colonIdx + 1).trim();

      for (const [placeholder, secret] of resolvedValues) {
        value = value.replaceAll(placeholder, secret);
      }

      // Sanitize resolved header values — prevent CRLF injection from vault secrets
      if (/[\r\n]/.test(value)) {
        console.error(`Resolved header "${name}" contains newline characters. Aborting to prevent header injection.`);
        process.exit(1);
      }
      resolvedHeaders[name] = value;
    }

    // 6. Make the actual HTTP request
    resolvedHeaders['Content-Type'] ??= 'application/json';

    try {
      const res = await fetch(url, {
        method: method.toUpperCase(),
        headers: resolvedHeaders,
        body: opts.data ?? undefined,
        signal: AbortSignal.timeout(60_000),
      });

      const contentType = res.headers.get('content-type') ?? '';
      const body = contentType.includes('json')
        ? JSON.stringify(await res.json(), null, 2)
        : await res.text();

      // 7. Output ONLY the response — secrets never printed
      process.stdout.write(body);
      if (!body.endsWith('\n')) process.stdout.write('\n');

      if (!res.ok) {
        process.exit(1);
      }
    } catch (err) {
      console.error(`HTTP request failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });
