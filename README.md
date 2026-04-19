# BKey

Biometric approval infrastructure for AI agents and developers.

BKey provides OAuth 2.1 + CIBA (Client-Initiated Backchannel Authentication) so that AI agents can request human approval — via facial biometrics on a mobile device — before taking sensitive actions like accessing secrets, making purchases, or signing transactions.

## Packages

### TypeScript / JavaScript

```bash
npm install @bkey/sdk    # Core client
npm install @bkey/cli -g # CLI tool
```

### Python

```bash
pip install bkey-sdk          # Core client
pip install bkey-sdk[async]   # + async support (httpx)
pip install bkey-sdk[all]     # Everything
```

### Go & Rust — coming soon

Go and Rust SDKs are in development. The `bkey` name is reserved on [crates.io](https://crates.io/crates/bkey). See [roadmap](#repository-structure) for status.

### JetBrains IDE plugin

Biometric approval gate on every git commit — works for human commits and AI
agents (Junie, Codex, AI Assistant) alike. See [integrations/jetbrains](./integrations/jetbrains/).

## Quick Start

### Request biometric approval (CIBA)

CIBA is BKey's core primitive — your agent requests approval, the user approves with facial biometrics on their phone.

```typescript
import { BKeyClient } from '@bkey/sdk';

const bkey = new BKeyClient({
  clientId: process.env.BKEY_CLIENT_ID,
  clientSecret: process.env.BKEY_CLIENT_SECRET,
});

// Request biometric approval for any action
const result = await bkey.approve('Deploy to production', {
  scope: 'approve:action',
  userDid: 'did:bkey:...',
});

if (result.approved) {
  // result.accessToken is a short-lived EdDSA JWT proving consent
  console.log('User approved!');
}
```

### CLI

```bash
# Human login (device authorization flow)
bkey auth login

# Request biometric approval for any action
bkey approve "Deploy to production" --scope approve:action

# Store a secret in the vault (biometric access control)
bkey vault store --key API_KEY --value sk-...

# Agent-initiated checkout (built on CIBA)
bkey checkout request --merchant "Store" --amount 29.99 --currency USD
```

## Architecture

```
┌─────────────┐     OAuth 2.1      ┌──────────────┐    Push + CIBA    ┌──────────────┐
│  Your Agent  │ ──────────────────>│  BKey Server  │ ────────────────>│  Mobile App  │
│  (SDK/CLI)   │  client_credentials│  (API)        │  approval request│  (Biometrics) │
└─────────────┘     + CIBA          └──────────────┘                   └──────────────┘
```

**Key flows:**
- **Client Credentials** — Agent authenticates with `client_id` + `client_secret`
- **Device Authorization (RFC 8628)** — Human logs in via QR code on phone
- **CIBA** — Agent requests approval, user confirms with facial biometrics
- **Vault** — Store/retrieve encrypted secrets with biometric approval
- **Checkout** — Agent initiates purchase, user approves amount on phone

## Documentation

- [Developer Docs](https://bkey.id/docs) — Guides, API reference, SDK docs
- [Examples](./examples/) — Working code samples

## Repository Structure

```
typescript/             TypeScript SDK + CLI (pnpm monorepo)
python/                 Python SDK
rust/                   Rust SDK (name reserved on crates.io)
skills/                 Agent skills (agentskills.io standard)
examples/               Code samples for all languages
integrations/jetbrains/ JetBrains IDE plugin (Kotlin)
docs/                   Developer documentation (Mintlify)
specs/                  OpenAPI spec + protocol docs
```

## License

Apache-2.0
