// copyright © 2025-2026 bkey inc. all rights reserved.

/**
 * BKey-gated MCP server.
 *
 * Exposes a `deploy_to_production` tool that pauses mid-invocation,
 * pushes a biometric approval prompt to the user's phone via BKey CIBA,
 * and only runs the deploy after the returned token verifies.
 *
 * Wire this into Claude Desktop, Claude Code, Cursor, or any MCP-compatible
 * agent by pointing them at the built `dist/index.js` (see README).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BKey } from '@bkey/sdk';
import { verifyToken, BKeyAuthError } from '@bkey/node';
import { z } from 'zod';

// ── Config from env ──────────────────────────────────────────────────

const BKEY_API_URL = process.env.BKEY_API_URL ?? 'https://api.bkey.id';
const BKEY_ISSUER = process.env.BKEY_ISSUER ?? BKEY_API_URL;
const BKEY_CLIENT_ID = process.env.BKEY_CLIENT_ID;
const BKEY_CLIENT_SECRET = process.env.BKEY_CLIENT_SECRET;
const BKEY_USER_DID = process.env.BKEY_USER_DID;
const APPROVAL_SCOPE = process.env.BKEY_APPROVAL_SCOPE ?? 'approve:deploy';

if (!BKEY_CLIENT_ID || !BKEY_CLIENT_SECRET) {
  console.error(
    '[bkey-mcp] BKEY_CLIENT_ID and BKEY_CLIENT_SECRET are required. ' +
      'See .env.example.',
  );
  process.exit(1);
}
if (!BKEY_USER_DID) {
  console.error(
    '[bkey-mcp] BKEY_USER_DID is required — it identifies the user who ' +
      'will receive the biometric approval prompt. See .env.example.',
  );
  process.exit(1);
}

// ── BKey client (agent mode: client credentials + user DID) ──────────

const bkey = new BKey({
  apiUrl: BKEY_API_URL,
  clientId: BKEY_CLIENT_ID,
  clientSecret: BKEY_CLIENT_SECRET,
  did: BKEY_USER_DID,
});

// ── Mock deploy (replace with your real action) ──────────────────────

async function runDeploy(args: {
  service: string;
  ref: string;
  approvedBy: string;
  jti?: string;
}): Promise<{ deploymentId: string }> {
  // This is where you'd call your deploy pipeline, kubectl, Terraform, etc.
  // We return a synthetic deployment ID so the example runs end-to-end.
  const deploymentId = `deploy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  console.error(
    `[bkey-mcp] deploy ${args.service}@${args.ref} → ${deploymentId} ` +
      `(approver=${args.approvedBy}, jti=${args.jti ?? '-'})`,
  );
  return { deploymentId };
}

// ── MCP server ───────────────────────────────────────────────────────

const server = new McpServer({
  name: 'bkey-deploy-gate',
  version: '0.1.0',
});

server.registerTool(
  'deploy_to_production',
  {
    title: 'Deploy to production',
    description:
      'Deploys a service to production after requiring biometric approval ' +
      'from the operator via BKey. A push notification is sent to the ' +
      "operator's phone; the tool blocks until they approve or deny.",
    inputSchema: {
      service: z.string().min(1).describe('Service name to deploy, e.g. "api-gateway".'),
      ref: z
        .string()
        .min(1)
        .describe('Git ref to deploy, e.g. "main" or a commit SHA.'),
    },
  },
  async ({ service, ref }) => {
    const bindingMessage = `Deploy ${service}@${ref} to production`;

    // 1. Initiate CIBA approval. BKey pushes a biometric prompt to the
    //    user's phone and blocks here until they approve, deny, or timeout.
    let approval;
    try {
      approval = await bkey.approve(bindingMessage, {
        scope: APPROVAL_SCOPE,
        actionDetails: {
          type: 'deploy',
          description: bindingMessage,
          resource: `${service}@${ref}`,
        },
        expirySeconds: 300,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: 'text',
            text: `Approval request failed: ${message}`,
          },
        ],
        isError: true,
      };
    }

    if (!approval.approved) {
      return {
        content: [
          { type: 'text', text: 'Deploy denied by operator on device.' },
        ],
        isError: true,
      };
    }

    // 2. Verify the returned access token server-side before acting on it.
    //    Don't trust `approval.approved` alone — the token is the
    //    cryptographic attestation.
    let claims;
    try {
      claims = await verifyToken(approval.accessToken, {
        issuer: BKEY_ISSUER,
        scope: APPROVAL_SCOPE,
      });
    } catch (err) {
      if (err instanceof BKeyAuthError) {
        return {
          content: [
            {
              type: 'text',
              text:
                `Approval token rejected (${err.code}): ${err.message}. ` +
                'Refusing to deploy.',
            },
          ],
          isError: true,
        };
      }
      throw err;
    }

    // 3. Now run the actual deploy, attributed to the verified subject.
    const { deploymentId } = await runDeploy({
      service,
      ref,
      approvedBy: claims.sub,
      jti: claims.jti,
    });

    return {
      content: [
        {
          type: 'text',
          text:
            `Deployed ${service}@${ref}.\n` +
            `  deployment: ${deploymentId}\n` +
            `  approver:   ${claims.sub}\n` +
            `  jti:        ${claims.jti ?? '-'}\n` +
            `  scope:      ${approval.scope}`,
        },
      ],
    };
  },
);

// ── Connect stdio transport ──────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);

// Log to stderr only — stdout is reserved for the MCP JSON-RPC stream.
console.error('[bkey-mcp] server connected via stdio');
