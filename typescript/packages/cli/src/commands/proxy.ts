// copyright © 2025-2026 bkey inc. all rights reserved.

import { Command } from 'commander';
import { createDecipheriv, createHash } from 'node:crypto';
import { x25519 } from '@noble/curves/ed25519';
import { createClient } from '../lib/config.js';
import type { X402AuthorizeResponse, MppAuthorizeResponse } from '@bkey/sdk';
import { pollAccessRequest } from '@bkey/sdk';

/**
 * Stream a paid-retry response to stdout and propagate its exit status.
 * Shared between the four payment retry branches (x402 auto/CIBA, MPP auto/CIBA)
 * to avoid drift between parallel copy-pasted blocks.
 */
async function streamPaidResponse(res: Response): Promise<never | void> {
  const ct = res.headers.get('content-type') ?? '';
  const body = ct.includes('json')
    ? JSON.stringify(await res.json(), null, 2)
    : await res.text();
  process.stdout.write(body);
  if (!body.endsWith('\n')) process.stdout.write('\n');
  if (!res.ok) process.exit(1);
}

/** Parse EIP-155 chain ID from x402 network field (e.g., 'eip155:8453' → 8453). */
function parseChainId(network?: string): number {
  if (!network) return 8453; // default: Base mainnet
  // CAIP-2 format: namespace:reference (e.g., 'eip155:8453'). The chain ID is
  // the *reference*, not the first run of digits — a naive /(\d+)/ match would
  // pick up '155' from 'eip155'. Split and take the part after the namespace.
  const parts = network.split(':');
  const ref = parts.length > 1 ? parts[parts.length - 1] : parts[0];
  const n = parseInt(ref ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 8453;
}

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

// ─── MPP SPT retry helper ───────────────────────────────────────────────────

/**
 * Build a RequestInit that carries the MPP Shared Payment Token in both a
 * custom `X-Payment-Spt` header and — for methods that carry a body — in a
 * JSON body field. This is belt-and-braces: MPP's merchant-facing wire
 * format is still settling, so we present the SPT both ways rather than
 * guessing one. Merchants reading from either location get the token.
 */
function mergeSptIntoRequest(
  req: { method: string; headers: Record<string, string>; body?: string },
  sptId: string,
): RequestInit {
  const hasBody = !['GET', 'HEAD', 'DELETE', 'OPTIONS'].includes(req.method.toUpperCase());
  const headers: Record<string, string> = {
    ...req.headers,
    'X-Payment-Spt': sptId,
  };

  if (!hasBody) {
    return { method: req.method, headers, signal: AbortSignal.timeout(60_000) };
  }

  // Merge SPT into an existing JSON body if present; otherwise start fresh.
  let bodyObj: Record<string, unknown> = {};
  if (req.body) {
    try {
      const parsed = JSON.parse(req.body) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        bodyObj = parsed as Record<string, unknown>;
      }
    } catch {
      // Non-JSON body — leave body untouched; the merchant must read the header.
      return {
        method: req.method,
        headers,
        body: req.body,
        signal: AbortSignal.timeout(60_000),
      };
    }
  }

  bodyObj.shared_payment_granted_token = sptId;
  headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';

  return {
    method: req.method,
    headers,
    body: JSON.stringify(bodyObj),
    signal: AbortSignal.timeout(60_000),
  };
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
  .option('--agent', 'Force agent mode')
  .option('--human', 'Force human mode (default)')
  .option('--profile <name>', 'Profile to use within the selected principal')
  .action(async (method: string, url: string, opts: {
    header?: string[];
    data?: string;
    purpose: string;
    timeout: string;
    agent?: boolean;
    human?: boolean;
    profile?: string;
  }) => {
    const api = createClient({ agent: opts.agent, human: opts.human, profile: opts.profile });
    const headers = opts.header ?? [];

    // 1. Parse {vault:xxx} placeholders from headers. With no placeholders we
    //    skip straight to the HTTP request — the 402 auto-payment flow below
    //    still runs. Vault injection and payment authorization are independent.
    const refs = parseVaultRefs(headers);
    const resolvedValues = new Map<string, string>();

    const parsedTimeout = parseInt(opts.timeout, 10);
    if (isNaN(parsedTimeout) || parsedTimeout <= 0) {
      console.error(`Invalid timeout: "${opts.timeout}". Must be a positive number of seconds.`);
      process.exit(1);
    }
    const timeoutMs = parsedTimeout * 1000;

    // 2. For each unique vault item, generate ephemeral key and request access
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

      // 7. Handle HTTP 402 — automatic x402/MPP payment
      if (res.status === 402) {
        const paymentRequiredHeader = res.headers.get('payment-required');
        if (paymentRequiredHeader) {
          console.error('\n💳 Payment required (x402). Initiating authorization...');
          try {
            const paymentRequired = JSON.parse(
              Buffer.from(paymentRequiredHeader, 'base64').toString('utf-8'),
            );

            // Authorize via BKey x402 endpoint
            const authRes = (await api.request('POST', '/v1/x402/authorize', {
              amountCents: Math.ceil(Number(paymentRequired.maxAmountRequired) / 10_000),
              recipientAddress: paymentRequired.payTo,
              chainId: parseChainId(paymentRequired.network),
              limitCurrency: 'USD',
              description: paymentRequired.description ?? `Pay for ${url}`,
              resource: paymentRequired.resource ?? url,
            })) as X402AuthorizeResponse;

            if (authRes.status === 'authorized' && authRes.authorization) {
              console.error('✅ Auto-approved. Retrying with payment...');
              const signedPayload = Buffer.from(
                JSON.stringify(authRes.authorization),
              ).toString('base64');
              const paidRes = await fetch(url, {
                method: method.toUpperCase(),
                headers: { ...resolvedHeaders, 'PAYMENT-SIGNATURE': signedPayload },
                body: opts.data ?? undefined,
                signal: AbortSignal.timeout(60_000),
              });
              await streamPaidResponse(paidRes);
              return;
            } else if (authRes.authorizationId) {
              console.error('📱 Biometric approval required — check your phone.');

              // Poll for the signed payload (respect --timeout)
              const signed = await api.pollX402Authorization(
                authRes.authorizationId,
                { timeoutMs },
              );
              if (!signed.signedPayload) {
                throw new Error('x402 poll resolved without a signed payload');
              }

              // Retry the original request with the payment signature
              console.error('✅ Approved. Retrying with payment...');
              const paidRes = await fetch(url, {
                method: method.toUpperCase(),
                headers: { ...resolvedHeaders, 'PAYMENT-SIGNATURE': signed.signedPayload },
                body: opts.data ?? undefined,
                signal: AbortSignal.timeout(60_000),
              });
              await streamPaidResponse(paidRes);
              return;
            } else {
              // Backend returned pending_approval with neither authorizationId
              // nor an authorization payload we can use — don't silently
              // exit 0 as if nothing happened.
              console.error(
                `x402 authorize: backend returned status=${authRes.status} with no ` +
                  `authorizationId or authorization payload — cannot poll. ` +
                  `(authReqId=${authRes.authReqId ?? '-'})`,
              );
              process.exit(1);
            }
          } catch (payErr) {
            console.error(`x402 payment failed: ${(payErr as Error).message}`);
            process.exit(1);
          }
        } else {
          // MPP uses `X-Payment-Required` (raw JSON in the header value) rather
          // than x402's `PAYMENT-REQUIRED` (base64-encoded JSON). That's per
          // protocol: MPP's payload is small enough to fit inline; x402's
          // binary-adjacent fields (BigInt amounts, EVM addresses) round-trip
          // more reliably through base64.
          const mppHeader = res.headers.get('x-payment-required');
          if (mppHeader) {
            console.error('\n💳 Payment required (MPP/Stripe). Initiating authorization...');
            try {
              const mppRequired = JSON.parse(mppHeader);

              const mppAuthRes = (await api.request('POST', '/v1/mpp/authorize', {
                amountCents: mppRequired.amount ?? mppRequired.maxAmount,
                currency: mppRequired.currency ?? 'USD',
                paymentMethodId: mppRequired.paymentMethodId,
                merchantName: mppRequired.merchantName,
                description: mppRequired.description,
                resource: url,
              })) as MppAuthorizeResponse;

              // MPP retries: present the SPT in both an `X-Payment-Spt` header
              // and (for body-carrying methods) a JSON body field, so we work
              // whether the merchant reads from headers or body. The Stripe
              // form-field name `payment_method_data[shared_payment_granted_token]`
              // is not a valid HTTP header name (brackets fail WHATWG Fetch),
              // so we use a clean header and mirror the value in the body.
              if (mppAuthRes.status === 'authorized' && mppAuthRes.sptId) {
                console.error('✅ Auto-approved. Retrying with SPT...');
                const paidRes = await fetch(url, mergeSptIntoRequest({
                  method: method.toUpperCase(),
                  headers: resolvedHeaders,
                  body: opts.data,
                }, mppAuthRes.sptId));
                await streamPaidResponse(paidRes);
                return;
              } else if (mppAuthRes.authorizationId) {
                console.error('📱 Biometric approval required — check your phone.');
                const mppSigned = await api.pollMppAuthorization(mppAuthRes.authorizationId, { timeoutMs });
                if (!mppSigned.sptCredential) {
                  throw new Error('MPP poll resolved without an SPT credential');
                }

                console.error('✅ Approved. Retrying with SPT...');
                const sptData = JSON.parse(Buffer.from(mppSigned.sptCredential, 'base64').toString());
                const paidRes = await fetch(url, mergeSptIntoRequest({
                  method: method.toUpperCase(),
                  headers: resolvedHeaders,
                  body: opts.data,
                }, sptData.sptId));
                await streamPaidResponse(paidRes);
                return;
              } else {
                console.error(
                  `MPP authorize: backend returned status=${mppAuthRes.status} with no ` +
                    `authorizationId or sptId — cannot proceed.`,
                );
                process.exit(1);
              }
            } catch (mppErr) {
              console.error(`MPP payment failed: ${(mppErr as Error).message}`);
              process.exit(1);
            }
          } else {
            console.error('HTTP 402 Payment Required — no payment header found.');
            process.exit(1);
          }
        }
        return;
      }

      // 8. Output response for non-402 responses
      const contentType = res.headers.get('content-type') ?? '';
      const body = contentType.includes('json')
        ? JSON.stringify(await res.json(), null, 2)
        : await res.text();

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
