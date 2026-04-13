---
name: bkey
description: "Secure API calls using credentials from the BKey mobile vault, and buy products from online stores with biometric facial biometrics approval. Use when: (1) making HTTP requests that need API keys, bearer tokens, or passwords, (2) the user says 'make an API call' or 'call an endpoint' with credentials, (3) accessing external services that require authentication stored in the vault, (4) running commands that need secret environment variables, (5) the user wants to purchase, buy, or order a product from a Shopify store. NOT for: requests that don't need authentication, local file operations, or git commands."
metadata:
  openclaw:
    emoji: "🔐"
    requires:
      bins:
        - bkey
        - curl
---

# BKey Skill

Make authenticated API calls using credentials stored securely in the BKey mobile vault, and purchase products from Shopify stores with biometric payment approval. Secrets are end-to-end encrypted and never exposed to the AI agent — they are injected at request time after the user approves on their phone.

## When to Use

- Making HTTP requests that require API keys, bearer tokens, or passwords
- The user asks to "call an API", "make a request", or "hit an endpoint" with credentials
- Running CLI commands that need secret environment variables
- Any task where credentials should not be visible in the conversation
- Requesting biometric approval for any sensitive action (deploy, access, payment)
- The user asks to "buy", "purchase", or "order" something from a Shopify store
- Completing a purchase hands-free with biometric approval

## When NOT to Use

- Requests that don't need authentication
- Local file operations, git commands, or code editing
- When the user has already provided the credential inline (don't re-wrap it)
- Browsing products without intent to buy (just browse normally)
- Non-Shopify stores (checkout requires Shopify checkout)
- Managing payment methods (use the BKey app directly)

## Authentication

The BKey CLI uses OAuth 2.1 for authentication. Two modes:

### Interactive login (human users)

```bash
bkey auth login                                    # Device authorization flow — approve on your phone
bkey auth login --base-url http://localhost:8080    # Local development (backend + verification page)
bkey auth status                                   # Show current auth state
bkey auth logout                                   # Revoke tokens and clear credentials
```

The device flow works like this:
1. CLI shows a verification URL, a one-time code, and a **QR code** in the terminal
2. **Scan the QR code** with your phone camera — opens the verification page with code pre-filled
3. The verification page shows another QR code that deep-links to the **BKey app**
4. Approve in the BKey app on your phone (facial biometrics)
5. CLI automatically receives tokens

In headless environments (Docker, SSH, OpenClaw), the terminal QR code is the primary way to connect your phone. The CLI also auto-opens the browser when available.

### Agent mode (CI/CD, Claude Code skill)

**Option 1 — Persistent agent credentials (recommended for Claude Code / Anthropic Claude):**

```bash
bkey auth setup-agent --name "Claude Code Agent" --save
```

This creates an OAuth client and saves credentials to `~/.bkey/agent.json`. All subsequent `bkey` commands automatically use the agent identity — CIBA approval prompts fire on the user's phone for each action.

**Option 2 — Environment variables (CI/CD, Docker, OpenClaw):**

```bash
export BKEY_CLIENT_ID=bkey_client_xxx
export BKEY_CLIENT_SECRET=bkey_secret_xxx
```

Create credentials: `bkey auth setup-agent --name "My Agent" --scopes approve:payment,approve:action,vault:access,identity:read`

For scripting/automation, use `--json` to get machine-parseable output:
```bash
bkey auth setup-agent --name "My Agent" --json | jq -r '.clientId'
```

### First-time agent setup (Claude Code / Anthropic Claude)

If `bkey auth status` shows "config file" (human login) but no agent credentials, the skill should set up agent mode first to ensure proper CIBA approval flows:

1. Run: `bkey auth setup-agent --name "Claude Code Agent" --save`
2. Approve the agent creation on your phone (if prompted)
3. Verify: `bkey auth status` should show "agent.json (persistent agent mode)"
4. All subsequent `bkey` commands use agent identity — human approves each action via facial biometrics

### Environment variables

| Variable | Description |
|----------|-------------|
| `BKEY_CLIENT_ID` | OAuth client ID (agent mode) |
| `BKEY_CLIENT_SECRET` | OAuth client secret (agent mode) |
| `BKEY_ACCESS_TOKEN` | Direct access token override |
| `BKEY_BASE_URL` | Backend base URL (default: https://api.bkey.id) |

## How It Works

1. You construct a `bkey proxy` or `bkey wrap` command with `{vault:item:field}` placeholders
2. The CLI sends an access request to the BKey backend with an ephemeral encryption key
3. The user receives a push notification on their phone and approves/denies
4. The secret is end-to-end encrypted from the phone to the CLI (the backend never sees it)
5. Only the response is returned — the secret is never printed or logged

## Commands

### Make an authenticated API call (bkey proxy)

Use `bkey proxy` to make HTTP requests with vault secrets injected into headers:

```bash
# GET request with Bearer token from vault
bkey proxy GET https://api.example.com/data \
  --header "Authorization: Bearer {vault:my-api-key}" \
  --purpose "Fetch data from example API"

# POST request with API key header
bkey proxy POST https://api.example.com/items \
  --header "X-API-Key: {vault:service-key:api_key}" \
  --data '{"name": "new item"}' \
  --purpose "Create new item"

# Multiple vault references in one request
bkey proxy GET https://api.example.com/secure \
  --header "Authorization: Bearer {vault:auth-token}" \
  --header "X-Client-Secret: {vault:client-creds:secret}" \
  --purpose "Authenticated request with client credentials"
```

### Run a command with secret env vars (bkey wrap)

Use `bkey wrap` to inject vault secrets as environment variables for any command:

```bash
# Run curl with a secret env var
bkey wrap --env API_KEY={vault:my-key} -- curl -H "Authorization: Bearer $API_KEY" https://api.example.com

# Run a script with multiple secrets
bkey wrap \
  --env DB_PASSWORD={vault:database:password} \
  --env API_TOKEN={vault:service:token} \
  -- python migrate.py
```

### List available vault items

```bash
bkey vault list
bkey vault list --type api_key
bkey vault list --type bearer_token
```

### Check authentication status

```bash
bkey auth status
```

## Vault Placeholder Syntax

```
{vault:<item-name>}           → resolves the "key" field (default)
{vault:<item-name>:<field>}   → resolves a specific field
```

- `item-name`: The name of the vault item (alphanumeric, hyphens, underscores, spaces)
- `field`: Optional field within the item (default: `key`)

## Agentic Checkout — Buy from Online Stores

Purchase products from Shopify stores with biometric payment approval via BKey. The AI agent browses the store in a real browser, finds products, adds them to cart, and extracts the checkout URL. Payment is approved via facial biometrics on the user's BKey app, then completed natively via Apple Pay or Shop Pay in the Shopify Checkout Kit.

### Prerequisites

- `bkey` CLI authenticated: `bkey auth status`
- Browser automation available (Claude in Chrome MCP)

**No API tokens or env vars needed.** The agent browses the store like a regular customer.

### Step 1: Ask for the Store URL

Ask the user which store they want to buy from. Accept any format:
- `cool-store.myshopify.com`
- `https://www.coolstore.com`
- `coolstore.com`

### Step 2: Browse the Store

Open the store URL in the browser using Claude in Chrome.

- If the store shows a **password page** (common for development/preview stores), ask the user for the store password and enter it
- Navigate through the store to find products matching the user's request
- Use the store's built-in search if available, or browse collections/categories

### Step 3: Select Product and Variant

Present the products found to the user with:
- Product name and description
- Available variants (size, color, etc.)
- Price

Let the user confirm which product and variant they want.

### Step 4: Add to Cart and Get Checkout URL

1. Select the correct variant (size, color, etc.) on the product page
2. Click "Add to Cart"
3. Navigate to the cart page
4. Click "Checkout" or find the checkout button
5. Extract the **checkout URL** from the browser's address bar (it will be a Shopify checkout URL like `https://cool-store.myshopify.com/checkouts/...`)
6. Also note the total price from the checkout page

### Step 5: Request BKey Payment Approval

Use the BKey CLI to request biometric payment approval. This sends a push notification to the user's phone.

```bash
bkey checkout request \
  --url "CHECKOUT_URL" \
  --merchant "MERCHANT_NAME" \
  --domain "STORE_DOMAIN" \
  --amount AMOUNT_IN_CENTS \
  --currency "USD" \
  --item "PRODUCT_TITLE:QUANTITY:PRICE_CENTS"
```

- `CHECKOUT_URL`: The full checkout URL extracted from the browser
- `MERCHANT_NAME`: The store name (from the page title or header)
- `STORE_DOMAIN`: The store's domain (e.g., `cool-store.myshopify.com`)
- `AMOUNT_IN_CENTS`: Total price in cents (e.g., $29.99 = 2999)

In agent mode (BKEY_CLIENT_ID/SECRET set), this command:
1. Initiates a CIBA backchannel auth request (approve:payment scope)
2. Sends a push notification to the user's phone
3. Waits for the user to approve with facial biometrics (CIBA approval)
4. Uses the short-lived CIBA token to create a checkout request
5. Waits for payment completion via Shopify Checkout Kit
6. Returns the order confirmation

In user mode (bkey auth login), this command calls checkout directly with the user's token.

### Step 6: Confirm to User

After the command completes successfully, tell the user:
- Order confirmation details
- What was purchased and the total charged
- That payment was authorized via BKey facial biometrics

### Checkout Error Handling

- If the store is password-protected, ask the user for the password — do not guess or skip
- If the user declines on their phone, the CLI exits with "Checkout was declined by the user."
- If the request times out (default 5 minutes), offer to retry
- If the product is out of stock, inform the user and suggest alternatives on the page
- Never ask the user for card details — all payment is handled by BKey + Apple Pay

### Checkout Example

```
User: Buy a medium black t-shirt from cool-store.myshopify.com

Agent: Let me open cool-store.myshopify.com in the browser...

[opens store, browses products, finds "Classic Black Tee"]

Agent: I found "Classic Black Tee" in Medium for $29.99. Want me to go ahead and purchase it?

User: Yes

Agent: Adding to cart and proceeding to checkout...
Requesting payment approval via BKey.
Please approve the $29.99 charge on your BKey app (facial biometrics required).

[bkey checkout request runs, user approves on phone, completes Apple Pay]

Agent: Order confirmed! Classic Black Tee (M), $29.99. Order #1234.
Payment was authorized via BKey facial biometrics.
```

### Password-Protected Store Example

```
User: Buy something from my-dev-store.myshopify.com

Agent: The store is password-protected. What's the store password?

User: secretpass123

Agent: Got it, entering the password...

[enters password, store loads]

Agent: I can see the store now. What product are you looking for?
```

## Request Biometric Approval (bkey approve)

Use `bkey approve` to request biometric CIBA approval from a user via push notification. This is the core primitive for human-in-the-loop authorization — the user reviews the request on their phone and approves with facial biometrics.

**Requires agent mode** (BKEY_CLIENT_ID + BKEY_CLIENT_SECRET).

```bash
# Simple action approval
bkey approve "Deploy to production" --scope approve:action --user-did did:bkey:...

# Payment approval with details
bkey approve "Buy office supplies" \
  --scope approve:payment \
  --amount 5000 \
  --currency USD \
  --recipient "amazon.com" \
  --user-did did:bkey:...

# JSON output for scripting
bkey approve "Access database" --scope approve:action --json --user-did did:bkey:...
# → {"approved":true,"access_token":"eyJ...","scope":"openid approve:action","expires_in":300}
```

The user receives a push notification on their BKey app showing the binding message, action details, and scopes. They approve with facial biometrics or deny.

### Using the SDK directly (TypeScript)

The CLI's `approve` command is a thin wrapper over `@bkey/sdk`. For programmatic use:

```typescript
import { BKey } from '@bkey/sdk';

const bkey = new BKey({
  apiUrl: 'https://api.bkey.id',
  clientId: process.env.BKEY_CLIENT_ID,
  clientSecret: process.env.BKEY_CLIENT_SECRET,
});

// Simple approval
const result = await bkey.approve('Deploy to production', {
  userDid: 'did:bkey:...',
  scope: 'approve:action',
});

if (result.approved) {
  console.log('Approved! Token:', result.accessToken);
}

// Payment approval with details
const payment = await bkey.approve('Buy supplies from Amazon', {
  userDid: 'did:bkey:...',
  scope: 'approve:payment',
  actionDetails: {
    type: 'payment',
    description: 'Office supplies',
    amount: 5000,
    currency: 'USD',
    recipient: 'amazon.com',
  },
});
```

### Third-party integration: using the CIBA token as proof of consent

When you use `bkey.approve()`, the returned `accessToken` is a short-lived EdDSA JWT that **proves** the user approved the specific action. There are two ways to use it:

**Pattern A: BKey as resource server (checkout, vault)**
The token is passed to BKey's own endpoints which require the approved scope:

```typescript
const result = await bkey.approve('Buy from Cool Store', {
  scope: 'approve:payment', userDid: '...',
});

// Use the CIBA token to call BKey's checkout endpoint
await bkey.requestWithToken('POST', '/v1/checkout/initiate',
  result.accessToken, { merchantName: 'Cool Store', amount: 2999, ... });
```

**Pattern B: BKey as approval provider (your own actions)**
The token is cryptographic proof of consent — your agent checks approval and does its own thing:

```typescript
const result = await bkey.approve('Delete production database', {
  scope: 'approve:action', userDid: '...',
});

if (result.approved) {
  // The token proves the user said yes — now execute YOUR action
  await deleteProductionDatabase();
}
```

For higher assurance, your backend can verify the token against BKey's `/oauth/userinfo` endpoint:

```typescript
// Verify the token is real and check who approved
const userinfo = await fetch('https://api.bkey.id/oauth/userinfo', {
  headers: { Authorization: `Bearer ${result.accessToken}` },
});
const { sub, scope } = await userinfo.json();
// sub = user's DID, scope = approved scopes (e.g. "openid approve:action")
```

Or verify the JWT signature directly against BKey's JWKS (`/oauth/jwks`) for offline validation without a network call.

**CIBA flow summary for third-party developers:**
1. Register as an agent: `bkey auth setup-agent --name "My Agent" --scopes approve:action`
2. In your code: `const result = await bkey.approve("Action description")`
3. User gets push notification → reviews → approves with facial biometrics
4. You get back `{ approved: true, accessToken: "...", scope: "...", expiresIn: 300 }`
5. Use the token as proof of consent, or verify it via `/oauth/userinfo`

## Important Notes

- **Approval required**: Every vault access requires explicit approval on the user's phone
- **Secrets never logged**: The CLI writes status to stderr and only the HTTP response to stdout
- **Ephemeral keys**: A fresh encryption key pair is generated for every request
- **Timeout**: Default approval timeout is 120 seconds (configurable with `--timeout`)
- **Purpose**: Always include a meaningful `--purpose` so the user knows what they're approving
- When constructing commands, prefer `bkey proxy` over `bkey wrap` for HTTP requests — it's simpler and more secure
- If the user says "use my API key for X" or "call X with credentials", use `{vault:<item-name>}` placeholders — ask the user for the vault item name if unclear

## Security

- The agent NEVER sees card numbers, payment details, or financial credentials
- All payment is handled natively via Apple Pay / Shop Pay inside the BKey app
- BKey's role is biometric authorization — confirming the user approves the charge
- The checkout URL is passed to the native Shopify Checkout Kit on the phone
- The agent browses the store like a regular customer — no API tokens or store-owner credentials needed
- Communication between CLI and backend is authenticated via OAuth 2.1 (client credentials or device authorization)
