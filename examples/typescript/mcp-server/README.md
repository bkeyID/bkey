# BKey-gated MCP server example

An [MCP](https://modelcontextprotocol.io) server that gates tool calls behind **real user consent** — specifically, a biometric approval pushed to the operator's phone via BKey CIBA.

Today, when an AI agent (Claude Desktop, Claude Code, Cursor, etc.) wants to invoke a sensitive tool, the client pops a dialog and the user clicks Allow. That click has no audit trail, no device binding, and no cryptographic proof the human actually consented — anyone with the agent open can approve anything.

This example shows how to replace that soft UI consent with a **signed, biometrically bound, replay-resistant** approval token:

```
agent calls deploy_to_production
  └─> MCP server calls bkey.approve("Deploy api-gateway@abc123 to prod")
        └─> push to operator's phone
              └─> operator approves with facial biometrics
                    └─> BKey returns EdDSA-signed CIBA token (sub, jti, scope)
                          └─> server verifies token with @bkey/node
                                └─> runs the actual deploy
```

Every tool call produces a signed, auditable attestation: who approved, when, for what action.

## What it exposes

A single MCP tool:

| Tool | Arguments | Behavior |
|---|---|---|
| `deploy_to_production` | `service: string`, `ref: string` | Blocks until operator biometrically approves on phone; then runs a mock deploy and returns the verified approver DID + deployment ID. |

The deploy itself is a stub — replace `runDeploy()` in `src/index.ts` with your real pipeline call (GitHub Actions dispatch, `kubectl apply`, Terraform run, etc.).

## Setup

This example installs `@bkey/sdk` and `@bkey/node` straight from npm — it's a standalone package you can copy out of the monorepo unchanged.

```bash
cd examples/typescript/mcp-server
npm install
npm run build
```

Create a `.env` file next to `package.json` (copy from `.env.example`) and fill in:

| Variable | Where to get it |
|---|---|
| `BKEY_CLIENT_ID` / `BKEY_CLIENT_SECRET` | Register an **agent client** at [bkey.id](https://bkey.id) (agent clients use the `client_credentials` grant). |
| `BKEY_USER_DID` | The user who will get the approval push. In the BKey mobile app: Settings → Developer → Copy DID. |
| `BKEY_APPROVAL_SCOPE` | The scope this server requests and verifies (default `approve:deploy`). Keep tight — one scope per sensitive action. |

## Using it with Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "bkey-deploy-gate": {
      "command": "node",
      "args": ["/absolute/path/to/examples/typescript/mcp-server/dist/index.js"],
      "env": {
        "BKEY_API_URL": "https://api.bkey.id",
        "BKEY_CLIENT_ID": "your-agent-client-id",
        "BKEY_CLIENT_SECRET": "your-agent-client-secret",
        "BKEY_USER_DID": "did:bkey:...",
        "BKEY_APPROVAL_SCOPE": "approve:deploy"
      }
    }
  }
}
```

Restart Claude Desktop. The `deploy_to_production` tool shows up in the tool list; invoking it fires a push to your phone.

## Using it with Claude Code

```bash
claude mcp add bkey-deploy-gate \
  --command node \
  --args /absolute/path/to/examples/typescript/mcp-server/dist/index.js \
  --env BKEY_CLIENT_ID=...,BKEY_CLIENT_SECRET=...,BKEY_USER_DID=did:bkey:...
```

## How the verification works

The server does **two** checks before trusting the approval:

1. `bkey.approve()` returns `{ approved: true, accessToken }` — this tells you the CIBA flow completed without an error.
2. `verifyToken(accessToken, { issuer, scope })` — this is the one that actually matters. It:
   - Fetches BKey's JWKS and verifies the EdDSA signature (pinned algorithm — no HS256 confusion, no `alg: none`).
   - Checks `iss`, `exp`, `iat`, required claims.
   - Requires the exact `scope` you're gating on.
   - Returns typed, null-prototype claims.

Skipping step 2 and just trusting the boolean is the biggest mistake you can make. **Always verify the token.**

## Extending this

- **Scope per action.** One tool → one scope. `approve:deploy` for deploys, `approve:refund` for refunds, `approve:db:drop` for schema changes. Scopes appear on the user's phone and in audit logs.
- **Bind to action details.** `actionDetails` (set in `bkey.approve()`) shows the user *exactly* what they're approving. Include the amount, target, recipient — anything the user needs to decide safely.
- **Use `jti` for replay protection.** Every BKey approval token has a unique `jti`. Record it server-side and reject replays.
- **Multi-user.** This example hardcodes one `BKEY_USER_DID`. For a shared MCP server, resolve the DID from the tool's context (e.g., the agent's authenticated session, a mapping table, or an OAuth flow on first use).

## References

- [@bkey/sdk on npm](https://www.npmjs.com/package/@bkey/sdk) — `bkey.approve()` source of truth
- [@bkey/node on npm](https://www.npmjs.com/package/@bkey/node) — token verification
- [Model Context Protocol spec](https://modelcontextprotocol.io/specification)
- [CIBA (RFC 8958 / OpenID)](https://openid.net/specs/openid-client-initiated-backchannel-authentication-core-1_0.html)
