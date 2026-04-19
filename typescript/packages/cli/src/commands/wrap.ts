// copyright © 2025-2026 bkey inc. all rights reserved.

import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { createDecipheriv, createHash } from 'node:crypto';
import { x25519 } from '@noble/curves/ed25519';
import { requireConfig } from '../lib/config.js';
import { BKey, pollAccessRequest } from '@bkey/sdk';

const VAULT_PLACEHOLDER = /\{vault:([a-zA-Z0-9_ -]+?)(?::([a-zA-Z0-9_-]+))?\}/g;

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

export const wrapCommand = new Command('wrap')
  .description('Run a command with vault secrets as environment variables')
  .option('--env <envs...>', 'Environment variables with vault refs: VAR={vault:name}')
  .option('--purpose <purpose>', 'Purpose for approval notification', 'CLI wrap command')
  .option('--timeout <seconds>', 'Approval timeout in seconds', '120')
  .option('--agent', 'Force agent mode (use ~/.bkey/agent.json)')
  .argument('<command...>', 'Command to run (use -- before it)')
  .action(async (command: string[], opts: {
    env?: string[];
    purpose: string;
    timeout: string;
    agent?: boolean;
  }) => {
    const config = requireConfig({ agent: opts.agent });
    const api = new BKey(config);
    const envDefs = opts.env ?? [];
    const parsedTimeout = parseInt(opts.timeout, 10);
    if (isNaN(parsedTimeout) || parsedTimeout <= 0) {
      console.error(`Invalid timeout: "${opts.timeout}". Must be a positive number of seconds.`);
      process.exit(1);
    }
    const timeoutMs = parsedTimeout * 1000;

    // parse VAR={vault:name} pairs
    const envMap = new Map<string, string>(); // VAR → raw value (with placeholders)
    const vaultRefs = new Map<string, { itemName: string; fieldPath: string; privateKey: Uint8Array }>();

    for (const e of envDefs) {
      const eqIdx = e.indexOf('=');
      if (eqIdx === -1) {
        console.error(`Invalid env format: "${e}". Use VAR={vault:name}.`);
        process.exit(1);
      }
      const varName = e.slice(0, eqIdx);
      const varValue = e.slice(eqIdx + 1);
      envMap.set(varName, varValue);

      let match;
      VAULT_PLACEHOLDER.lastIndex = 0;
      while ((match = VAULT_PLACEHOLDER.exec(varValue)) !== null) {
        const key = match[0];
        if (!vaultRefs.has(key)) {
          const privateKey = x25519.utils.randomPrivateKey();
          vaultRefs.set(key, {
            itemName: match[1],
            fieldPath: match[2] ?? 'key',
            privateKey,
          });
        }
      }
    }

    // resolve all vault refs
    const resolved = new Map<string, string>();

    for (const [placeholder, ref] of vaultRefs) {
      const publicKey = x25519.getPublicKey(ref.privateKey);

      process.stderr.write(`Requesting access to "${ref.itemName}"... `);

      const accessRes = (await api.createAccessRequest({
        itemName: ref.itemName,
        fieldPath: ref.fieldPath,
        purpose: opts.purpose,
        ephemeralPublicKey: Buffer.from(publicKey).toString('base64'),
      })) as { id: string };

      process.stderr.write('waiting for approval...\n');

      const status = await pollAccessRequest(api, accessRes.id, timeoutMs);
      if (!status.e2eeCiphertext) throw new Error('No encrypted value returned.');

      resolved.set(placeholder, decryptE2EE(status.e2eeCiphertext, ref.privateKey));
      process.stderr.write(`Access to "${ref.itemName}" granted.\n`);
    }

    // build env with resolved values
    const childEnv = { ...process.env };
    for (const [varName, rawValue] of envMap) {
      let finalValue = rawValue;
      for (const [placeholder, secret] of resolved) {
        finalValue = finalValue.replaceAll(placeholder, secret);
      }
      childEnv[varName] = finalValue;
    }

    // run the command
    const [cmd, ...args] = command;
    const child = spawn(cmd, args, {
      env: childEnv,
      stdio: 'inherit',
    });

    child.on('exit', (code) => {
      process.exit(code ?? 0);
    });
  });
