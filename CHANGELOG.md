# Changelog

All notable changes to the packages in this repo are tracked here. Packages are versioned independently — see the per-package sections below.

This repo follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [SemVer](https://semver.org/spec/v2.0.0.html). Pre-1.0 minor releases may include small breaking changes; those are called out explicitly under **Breaking**.

---

## `@bkey/cli` 0.3.0 — unreleased

### Breaking

- **Agent mode is now opt-in.** Previously, if `~/.bkey/agent.json` existed on disk it silently won over the user session from `bkey auth login` for every command, so a human's own terminal would quietly run as the agent. Now `config.json` is the default principal; agent mode is selected via `--agent`, `BKEY_MODE=agent`, or `BKEY_CLIENT_ID`+`BKEY_CLIENT_SECRET` env vars. Scripts that relied on `agent.json`'s implicit precedence must set one of those.
- **`bkey auth logout` no longer wipes `agent.json` by default.** It revokes the user session only. Pass `--agent` to remove agent credentials, or `--all` for the previous behavior.

### Added

- `--agent` flag on `approve`, `checkout request`, `checkout status`, `vault store`, `vault list`, `proxy`, `wrap`, `auth status`, `auth logout`.
- `BKEY_MODE=agent` environment variable (equivalent to `--agent`).
- `bkey auth status` now surfaces both principals: running without `--agent` still shows the user session, but appends a note when `agent.json` also exists so the agent is discoverable.
- `approve` defaults to agent mode (it's agent-only by nature) and falls back from `--user-did` to the saved session DID when present — the plugin / CLI caller no longer has to pass `--user-did` for self-approval.

### Fixed

- `bkey approve` previously required `--user-did` whenever agent mode was active because `requireConfig()` dropped the saved session DID on the floor. The target DID is now resolved at the command-semantic layer: `--user-did > ~/.bkey/config.json did > error`.

---

## `@bkey/sdk` 0.2.0 — 2026-04-18

### Added

- **Agent payments (x402)** — new methods on the `BKey` client:
  - `authorizeX402Payment({ amountCents, recipientAddress, chainId, ... })` — authorize a USDC-on-Base payment via EIP-3009.
  - `pollX402Authorization(authorizationId)` — poll until the user approves and the signed payload is ready.
  - `getX402Wallet()` / `getX402SpendingLimits()` — inspect the agent's wallet + per-agent limits.
  - Standalone `pollX402Authorization(apiUrl, token, id)` helper exported from `@bkey/sdk` for direct API use.
- **Agent payments (MPP / Stripe SPT)** — `authorizeMppPayment()` and `pollMppAuthorization()`.
- **Types** exported: `X402AuthorizeInput`, `X402AuthorizeResponse`, `X402PollResponse`, `X402SignedPayload`, `X402WalletInfo`, `SpendingLimit`, `MppAuthorizeInput`, `MppAuthorizeResponse`, `MppPollResponse`.
- **Shared poll defaults** — `POLL_INTERVAL_MS` and `DEFAULT_APPROVAL_TIMEOUT_MS` are now exported constants so `BKey.pollX402Authorization` / `pollMppAuthorization` and the standalone pollers can't drift apart.

### Changed

- `pollX402Authorization` + `pollMppAuthorization` default `timeoutMs` bumped **120_000 → 300_000** to match the CIBA approval request's 5-minute lifetime. Callers that want a shorter deadline can still pass `timeoutMs` explicitly.
- Consolidated three separate `export type { ... } from './types.js'` blocks in `index.ts` into one.

---

## `@bkey/cli` 0.2.0 — 2026-04-18

### Added

- **`bkey proxy`** now auto-detects the payment protocol on HTTP 402 responses:
  - `PAYMENT-REQUIRED` header → x402 flow (USDC on Base via EIP-3009).
  - `X-Payment-Required` header → MPP flow (Stripe Shared Payment Token).
  - Auto-approves within the agent's spending limit; otherwise pushes a biometric approval to the user's phone, then retries with the signed credential.
- **`setup-agent`** default scopes now include the protocol-neutral payment scopes: `payment:authorize`, `payment:address`, `payment:limits` — agents get x402 + MPP capability out of the box.
- **Typed response shapes** — x402 / MPP authorize paths in the proxy use `X402AuthorizeResponse` / `MppAuthorizeResponse` from `@bkey/sdk` (drops the previous `as any` cast; tsc catches backend drift now).

### Fixed

- **Payment-only proxy calls** (`bkey proxy GET <paid-url>` with no `{vault:...}` placeholders) now reach the 402 flow instead of exiting early.
- **CAIP-2 chain id parser** — `eip155:8453` correctly returns `8453`. The previous `/(\d+)/` regex returned `155` because it matched the namespace digits, which meant every x402 authorization from the proxy was requested for the wrong chain.
- **`--timeout`** is honored while polling x402 and MPP approvals (was hardcoded to 120s regardless of the flag).
- **MPP retry header** — the previous path used Stripe's form-field name `payment_method_data[shared_payment_granted_token]` as an HTTP header name, which isn't valid per RFC 7230 / WHATWG Fetch (brackets throw a `TypeError` before the request is sent). Replaced with a clean `X-Payment-Spt` header plus a `shared_payment_granted_token` JSON body field for body-carrying methods so whichever the merchant reads from wins.
- **Silent fall-through** — if the backend returns `pending_approval` with neither a usable credential nor an `authorizationId`, the proxy now errors loudly and exits 1 instead of returning success with no output.

### Internal

- Extracted `streamPaidResponse()` helper — the 4 previously copy-pasted fetch→content-type→stdout→exit blocks (x402 auto, x402 CIBA, MPP auto, MPP CIBA) now share one implementation.

---

## `bkey-sdk` (Python) 0.2.0 — 2026-04-18

### Added

- **`client.approve(message, user_did, scope=...)`** — one-call CIBA flow. Initiates the backchannel authorize, sends the push notification, polls until the user approves or denies, returns a `CIBAResult` with an EdDSA-signed JWT. This is the recommended integration path.

### Fixed

- **`initiate_approval()`** now sends the required `login_hint` (previously missing, causing every real-backend call to fail with a 400).
- **`approve()`** raises `ApprovalTimeoutError` on `expired` status and `ApprovalDeniedError` on missing-token results, instead of silently returning an unusable `CIBAResult`.
- **Timeout default** for `approve()` is now `expiry_seconds` instead of 120s, so polling won't stop while the phone prompt is still live.

### Breaking

- **`initiate_approval()` positional signature change**: the first positional argument is now `user_did` (was `scope`). The old signature never worked against the real backend (missing `login_hint`), so in practice no real-world caller shipped with it. A runtime guard catches the common upgrade mistake: if a scope-like string is passed where `user_did` is expected, the SDK raises `ValueError` with a clear migration message.

---

## `@bkey/node` — no changes since 0.1.0

No public API changes in this release window.

---

## Earlier releases

- `@bkey/sdk` 0.1.0, `@bkey/cli` 0.1.1, `@bkey/node` 0.1.0, `bkey-sdk` 0.1.0 — initial monorepo release.
