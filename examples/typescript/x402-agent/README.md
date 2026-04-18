# x402 Agent Example

AI agent that automatically pays for API access using the [x402 protocol](https://x402.org) with BKey biometric approval.

## How it works

1. Agent requests a premium API endpoint
2. Server returns `HTTP 402` with a `PAYMENT-REQUIRED` header
3. Agent calls BKey to authorize the payment (USDC on Base)
4. User approves on their phone with facial biometrics (or auto-approved within spending limits)
5. Agent retries with the signed `PAYMENT-SIGNATURE` header
6. Server verifies via the Coinbase facilitator and returns the resource

## Setup

```bash
# Install the BKey CLI
npm install -g @bkey/cli

# Login and create agent credentials
bkey auth login
bkey auth setup-agent --name "x402 Demo Agent" --save

# Clone and install
cd examples/typescript/x402-agent
cp .env.example .env
# Edit .env with your credentials
npm install
```

## Run

```bash
npm run dev
```

## Using `bkey proxy` (zero-code alternative)

Instead of writing code, you can use the BKey CLI proxy to handle x402 payments transparently:

```bash
# Any HTTP request through the proxy automatically handles 402 responses
bkey proxy GET https://x402-api.example.com/premium/data \
  --header "Authorization: Bearer {vault:api-key}"
```

The proxy detects `PAYMENT-REQUIRED` headers, authorizes the payment through BKey, waits for biometric approval, and retries the request automatically.

## Spending Limits

Configure per-agent spending limits in the BKey mobile app under **Settings > Spending Limits**. Payments within the limit are auto-approved (no phone notification). Payments above the limit require biometric approval.
