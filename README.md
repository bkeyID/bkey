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
pip install bkey          # Core client
pip install bkey[async]   # + async support (httpx)
pip install bkey[all]     # Everything
```

### Go (coming soon)

```bash
go get github.com/bkeyID/bkey/go
```

### Rust (coming soon)

```bash
cargo add bkey
```

## Quick Start

### Agent authentication (client credentials)

```typescript
import { BKeyClient } from '@bkey/sdk';

const bkey = new BKeyClient({
  clientId: process.env.BKEY_CLIENT_ID,
  clientSecret: process.env.BKEY_CLIENT_SECRET,
});

// Request biometric approval for a checkout
const checkout = await bkey.checkoutRequest({
  merchantName: 'Example Store',
  items: [{ name: 'Widget', price: 9.99 }],
  amount: 9.99,
  currency: 'USD',
});

// Poll until the user approves on their phone
const result = await bkey.pollCheckoutStatus(checkout.id);
console.log(result.status); // 'approved'
```

### CLI

```bash
# Human login (device authorization flow)
bkey auth login

# Store a secret in the vault
bkey vault store --key API_KEY --value sk-...

# Request checkout approval
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
typescript/     TypeScript SDK + CLI (pnpm monorepo)
python/         Python SDK
go/             Go SDK (coming soon)
rust/           Rust SDK (coming soon)
examples/       Code samples for all languages
docs/           Developer documentation (Mintlify)
specs/          OpenAPI spec + protocol docs
```

## License

Apache-2.0
