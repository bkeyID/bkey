# Changelog

All notable changes to the packages in this repo are tracked here. Packages are versioned independently — see the per-package sections below.

This repo follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [SemVer](https://semver.org/spec/v2.0.0.html). Pre-1.0 minor releases may include small breaking changes; those are called out explicitly under **Breaking**.

---

## `@bkey/cli` 0.3.0 — unreleased

### Breaking

- **Named profiles replace the `config.json` + `agent.json` duo.** All auth state now lives in a single `~/.bkey/profiles.json` (humans keyed by name, agents keyed by name, defaults pointer). On first 0.3.0 invocation the CLI auto-migrates any pre-existing `~/.bkey/config.json` / `~/.bkey/agent.json` into profiles named `default` and writes a one-time stderr notice. The legacy files are left on disk as a rollback aid for one release; the migration shim is removed in 0.4.0 (tracked in [#27](https://github.com/bkeyID/bkey/issues/27)).
- **Agent-mode precedence flipped.** `agent.json` (now the `agents.default` profile) no longer silently wins over a logged-in user session. Selection is now explicit: `--agent`, `BKEY_MODE=agent`, `BKEY_CLIENT_ID`+`BKEY_CLIENT_SECRET`, or `--profile <name>`. Scripts that relied on the old implicit precedence must set one of those.
- **`bkey auth logout` no longer wipes agent credentials by default.** Removes only the active human profile. Pass `--agent`, `--profile <name>`, or `--all` for broader scope.

### Added

- **Multi-profile support.** Store multiple humans and multiple agents side-by-side (e.g. `ide-agent`, `ci-agent`, `claude-code-agent`) with per-principal defaults.
- **Top-level `bkey profiles` command** — `list`/`ls`, `current`, `use <name>`, `rename`, `delete`/`rm`. `bkey profiles` with no args lists everything.
- **Profile selection flags** on every dual-mode command (`vault`, `proxy`, `wrap`, `checkout`): `--profile <name>`, `--agent`, `--human`. `BKEY_PROFILE` env var for shell workflows.
- **`bkey auth login --profile <name>`** creates a named human profile (default: `default`).
- **`bkey auth setup-agent --save --profile <name>`** saves an agent with an explicit identifier. If `--profile` is omitted, the identifier is slugified from `--name` (e.g. `--name "Deploy Bot"` → `deploy-bot`). Collisions error unless `--overwrite` is passed — avoids a silent-overwrite footgun on the second agent.
- **Approval-target DID resolution at the command layer.** `approve` / `checkout request` now resolve the target DID as `--user-did > active human profile DID > error`, so `bkey approve "msg"` under agent mode Just Works once you're logged in as a human.
- **Atomic writes.** The profile store is written via tmp-file + `fsync` + rename + directory `fsync`, with a `profiles.json.bak` rolled on every save so a single bad write cannot wipe every profile.

### Fixed

- `bkey approve` previously errored with "No user DID specified" whenever agent mode was active because `requireConfig()` dropped the saved session DID. The target DID is now resolved independently from caller identity.
- `bkey auth status` wasn't aware of competing principals; `status` and `status --agent` now show the appropriate profile view and surface the other principal's presence as a hint.
- **Refreshed access/refresh tokens are now persisted back to `profiles.json`.** Previously the SDK refreshed tokens in-memory only, so any human-mode CLI invocation that triggered a refresh would burn the refresh token — the next invocation failed with "refresh token already used". A new `createClient()` helper wires the SDK's `onTokenRefresh` + `reloadConfig` hooks automatically for every command that uses a human-profile principal. (Latent in 0.2.x; would have shipped as a regression at 0.3.0.)
- **`setup-agent` default `--scopes` trimmed** from a laundry list that included `payment:*`, `vault:*`, `signing:*` down to just `approve:action` — the minimum needed for the common case (CIBA approval agent) and a strict subset of what any user session grants. Users that need broader agents should pass `--scopes` explicitly. Previous default broke on any session whose grant didn't include all listed scopes (error: *"cannot grant scopes beyond your own"*).

### Internal

- Consolidated principal/profile resolution into `requireConfig({ principal, profile, agent, human })` with a single precedence chain.
- Added `createClient(opts)` / `wireHumanProfilePersistence(api, name)` in `src/lib/config.ts`; every command that builds an SDK client goes through them.
- Extracted the legacy `config.json` / `agent.json` read paths into a one-shot migration shim.
- New `src/lib/profiles.ts` owns all on-disk state; `config.ts` is now thin.

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
