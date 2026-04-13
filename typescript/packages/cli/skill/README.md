# BKey Skill for AI Agents

Secure credential proxy and agentic checkout for AI agents. The `bkey` skill lets agents make authenticated API calls using secrets from the BKey mobile vault, and purchase products from Shopify stores with biometric facial biometrics approval.

Secrets are end-to-end encrypted and never exposed to the AI agent. Payment is handled natively via Apple Pay / Shop Pay inside the BKey app.

## Capabilities

| Capability | Commands | Description |
|-----------|----------|-------------|
| **Vault proxy** | `bkey proxy`, `bkey wrap` | Authenticated API calls with secrets injected at request time |
| **Vault management** | `bkey vault list` | List available secrets |
| **Agentic checkout** | `bkey checkout request` | Buy from Shopify stores with biometric approval |
| **Auth** | `bkey auth login`, `bkey auth status` | CLI authentication |

See [`SKILL.md`](SKILL.md) for the full skill definition with usage examples and workflows.

## Using with OpenClaw

Run the full agentic checkout demo in [OpenClaw](https://github.com/yourclaw/openclaw):

```bash
make demo name=agentic-checkout
```

See [`demos/agentic-checkout/`](../../demos/agentic-checkout/) for setup details.

## Using with Claude Code

```bash
# Build and link the CLI
cd bkey-devkit/cli && npm ci && npm run build && npm link

# Authenticate (interactive — approve on your phone)
bkey auth login

# Or for agent/CI use:
export BKEY_CLIENT_ID=bkey_client_...
export BKEY_CLIENT_SECRET=bkey_secret_...
```

Then ask Claude to make authenticated API calls or buy something from a Shopify store.
