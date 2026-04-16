// copyright © 2025-2026 bkey inc. all rights reserved.

import type {
  AccessRequestInput,
  ActionDetails,
  ApprovalResult,
  BKeyConfig,
  CibaInitiateResponse,
  CibaTokenResponse,
  CheckoutRequestInput,
  StoreRequestInput,
  X402AuthorizeInput,
  X402AuthorizeResponse,
  X402PollResponse,
  X402WalletInfo,
  SpendingLimit,
} from './types.js';

/**
 * BKey SDK client.
 *
 * Provides biometric-gated approval (CIBA), vault access, and checkout
 * for AI agents and server-side applications.
 *
 * @example
 * ```ts
 * import { BKey } from '@bkey/sdk';
 *
 * const bkey = new BKey({
 *   apiUrl: 'https://api.bkey.id',
 *   clientId: process.env.BKEY_CLIENT_ID,
 *   clientSecret: process.env.BKEY_CLIENT_SECRET,
 * });
 *
 * const result = await bkey.approve('Deploy to production', {
 *   userDid: 'did:bkey:...',
 *   scope: 'approve:action',
 * });
 * ```
 */
export class BKey {
  private baseUrl: string;
  private config: BKeyConfig;
  private accessToken: string | null;
  private tokenExpiresAt: number | null;

  /**
   * Optional callback invoked when tokens are refreshed.
   * CLI uses this to persist updated tokens to disk.
   */
  onTokenRefresh?: (config: BKeyConfig) => void;

  /**
   * Optional callback to reload config (e.g. re-read from disk).
   * Used by CLI to handle concurrent refresh token rotation.
   */
  reloadConfig?: () => BKeyConfig | null;

  constructor(config: BKeyConfig) {
    this.baseUrl = config.apiUrl.replace(/\/$/, '');
    this.config = config;
    this.accessToken = config.accessToken ?? null;
    this.tokenExpiresAt = config.tokenExpiresAt
      ? new Date(config.tokenExpiresAt).getTime()
      : null;
  }

  // ─── Token management ──────────────────────────────────────────────

  private isTokenExpired(): boolean {
    if (!this.tokenExpiresAt) return false;
    return Date.now() > this.tokenExpiresAt - 60_000;
  }

  async getValidToken(): Promise<string> {
    return this.ensureAccessToken();
  }

  private async ensureAccessToken(): Promise<string> {
    if (this.config.clientId && this.config.clientSecret) {
      if (!this.accessToken || this.isTokenExpired()) {
        await this.exchangeClientCredentials();
      }
      return this.accessToken!;
    }

    if (this.accessToken && this.isTokenExpired()) {
      await this.refreshAccessToken();
    }

    if (!this.accessToken) {
      throw new Error('No access token. Authenticate first.');
    }

    return this.accessToken;
  }

  private async exchangeClientCredentials(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.config.clientId!,
        client_secret: this.config.clientSecret!,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(`Client credentials exchange failed: ${json.error_description ?? json.error ?? res.status}`);
    }

    this.accessToken = json.access_token as string;
    const expiresIn = json.expires_in as number;
    if (expiresIn) {
      this.tokenExpiresAt = Date.now() + expiresIn * 1000;
    }
  }

  private async refreshAccessToken(): Promise<void> {
    if (!this.config.refreshToken) {
      throw new Error('No refresh token. Authenticate first.');
    }
    if (!this.config.clientId) {
      throw new Error('Token refresh requires config.clientId.');
    }

    const clientId = this.config.clientId;
    const doRefresh = async (refreshToken: string): Promise<Response> =>
      fetch(`${this.baseUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: clientId,
        }),
        signal: AbortSignal.timeout(15_000),
      });

    let res = await doRefresh(this.config.refreshToken);
    let json = (await res.json()) as Record<string, unknown>;

    // Race condition: another process may have rotated the refresh token.
    if (!res.ok && json.error === 'invalid_grant' && this.reloadConfig) {
      const freshConfig = this.reloadConfig();
      if (freshConfig?.refreshToken && freshConfig.refreshToken !== this.config.refreshToken) {
        this.config = freshConfig;
        res = await doRefresh(freshConfig.refreshToken);
        json = (await res.json()) as Record<string, unknown>;
      }
    }

    if (!res.ok) {
      this.accessToken = null;
      throw new Error(`Token refresh failed: ${json.error_description ?? json.error ?? res.status}`);
    }

    this.accessToken = json.access_token as string;
    const expiresIn = json.expires_in as number;
    this.tokenExpiresAt = Date.now() + expiresIn * 1000;

    this.config.accessToken = json.access_token as string;
    if (json.refresh_token) {
      this.config.refreshToken = json.refresh_token as string;
    }
    this.config.tokenExpiresAt = new Date(this.tokenExpiresAt).toISOString();

    this.onTokenRefresh?.(this.config);
  }

  // ─── Generic request ───────────────────────────────────────────────

  /** @internal — exposed for CLI commands that need direct API access. */
  async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const token = await this.ensureAccessToken();
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });

    const json = (await res.json()) as Record<string, unknown>;

    if (!res.ok) {
      const errMsg = (json.error as Record<string, unknown>)?.message ?? `HTTP ${res.status}`;
      throw new Error(String(errMsg));
    }

    return json;
  }

  /** Make a request using a specific token (e.g. a CIBA approval token). */
  async requestWithToken(method: string, path: string, token: string, body?: unknown): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });

    const json = (await res.json()) as Record<string, unknown>;

    if (!res.ok) {
      const errMsg = (json.error as Record<string, unknown>)?.message ?? `HTTP ${res.status}`;
      throw new Error(String(errMsg));
    }

    return json;
  }

  // ─── Approval (CIBA) ──────────────────────────────────────────────

  /**
   * Request biometric approval from the user via CIBA push notification.
   *
   * The user receives a push notification on their BKey mobile app,
   * reviews the request, and approves with facial biometrics or denies.
   *
   * @example
   * ```ts
   * const result = await bkey.approve('Deploy to production');
   * if (result.approved) {
   *   console.log('Approved! Token:', result.accessToken);
   * }
   * ```
   */
  async approve(message: string, opts?: {
    scope?: string;
    actionDetails?: ActionDetails;
    userDid?: string;
    expirySeconds?: number;
    timeoutMs?: number;
  }): Promise<ApprovalResult> {
    const userDid = opts?.userDid ?? this.config.did;
    if (!userDid) {
      throw new Error('approve() requires a user DID. Pass opts.userDid or set config.did.');
    }

    const scope = opts?.scope ?? 'approve:action';
    const timeoutMs = opts?.timeoutMs ?? 300_000;

    const cibaRes = await this.initiateCiba({
      login_hint: userDid,
      scope: `openid ${scope}`,
      binding_message: message,
      action_details: opts?.actionDetails,
      requested_expiry: opts?.expirySeconds ?? Math.min(Math.ceil(timeoutMs / 1000), 600),
    });

    let tokenRes;
    try {
      tokenRes = await this.pollCibaToken(
        cibaRes.auth_req_id,
        (cibaRes.interval ?? 5) * 1000,
        timeoutMs,
      );
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('denied') || msg.includes('expired')) {
        return { approved: false, accessToken: '', scope: '', expiresIn: 0 };
      }
      throw err;
    }

    return {
      approved: true,
      accessToken: tokenRes.access_token,
      scope: tokenRes.scope,
      expiresIn: tokenRes.expires_in,
    };
  }

  /** Initiate a CIBA request for per-action approval. */
  async initiateCiba(data: {
    login_hint: string;
    scope: string;
    binding_message?: string;
    action_details?: ActionDetails;
    requested_expiry?: number;
  }): Promise<CibaInitiateResponse> {
    return (await this.request('POST', '/oauth/bc-authorize', data)) as CibaInitiateResponse;
  }

  /**
   * Poll for a CIBA token. Returns the token response on approval,
   * throws on denial/expiry.
   */
  async pollCibaToken(authReqId: string, intervalMs = 5000, timeoutMs = 300_000): Promise<CibaTokenResponse> {
    const deadline = Date.now() + timeoutMs;
    let currentInterval = intervalMs;

    while (Date.now() < deadline) {
      const res = await fetch(`${this.baseUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:openid:params:grant-type:ciba',
          auth_req_id: authReqId,
          client_id: this.config.clientId!,
          client_secret: this.config.clientSecret!,
        }),
        signal: AbortSignal.timeout(15_000),
      });

      const json = (await res.json()) as Record<string, unknown>;

      if (res.ok && json.access_token) {
        return json as unknown as CibaTokenResponse;
      }

      const error = json.error as string | undefined;
      if (error === 'authorization_pending') {
        await new Promise((r) => setTimeout(r, currentInterval));
        continue;
      }
      if (error === 'slow_down') {
        currentInterval = Math.min(currentInterval + 5000, 30000);
        await new Promise((r) => setTimeout(r, currentInterval));
        continue;
      }
      if (error === 'access_denied') {
        throw new Error('Authorization denied by user');
      }
      if (error === 'expired_token') {
        throw new Error('Authorization request expired');
      }
      throw new Error(`CIBA token error: ${json.error_description ?? error ?? res.status}`);
    }
    throw new Error('CIBA approval timed out');
  }

  // ─── Vault ─────────────────────────────────────────────────────────

  async getVaultPublicKey(): Promise<{ publicKey: string }> {
    const res = (await this.request('GET', '/v1/vault/keys')) as {
      success: boolean;
      publicKey: string;
    };
    return { publicKey: res.publicKey };
  }

  async listVaultItems(itemType?: string): Promise<unknown> {
    const params = itemType ? `?itemType=${encodeURIComponent(itemType)}` : '';
    return this.request('GET', `/v1/vault/items${params}`);
  }

  async createStoreRequest(data: StoreRequestInput): Promise<unknown> {
    return this.request('POST', '/v1/vault/items/store-request', data);
  }

  async getStoreRequestStatus(id: string): Promise<unknown> {
    return this.request('GET', `/v1/vault/items/store-request/${encodeURIComponent(id)}`);
  }

  async createAccessRequest(data: AccessRequestInput): Promise<unknown> {
    return this.request('POST', '/v1/vault/access', data);
  }

  async getAccessRequestStatus(id: string): Promise<unknown> {
    return this.request('GET', `/v1/vault/access/${encodeURIComponent(id)}`);
  }

  // ─── Checkout ──────────────────────────────────────────────────────

  async createCheckoutRequest(data: CheckoutRequestInput): Promise<unknown> {
    return this.request('POST', '/v1/checkout/initiate', data);
  }

  async getCheckoutRequestStatus(id: string): Promise<unknown> {
    return this.request('GET', `/v1/checkout/${encodeURIComponent(id)}/status`);
  }

  // ─── x402 / MPP Payments ─────────────────────────────────────────

  /**
   * Authorize an x402 payment. If within the agent's spending limit,
   * returns a signed payload immediately. Otherwise initiates CIBA
   * biometric approval and returns a pending status to poll.
   *
   * @example
   * ```ts
   * const auth = await bkey.authorizeX402Payment({
   *   amountCents: 100, // $1.00
   *   recipientAddress: '0x...',
   * });
   * if (auth.status === 'authorized') {
   *   // Use auth.authorization immediately
   * } else {
   *   // Poll for approval
   *   const signed = await bkey.pollX402Authorization(auth.authorizationId!);
   * }
   * ```
   */
  async authorizeX402Payment(input: X402AuthorizeInput): Promise<X402AuthorizeResponse> {
    return (await this.request('POST', '/v1/x402/authorize', {
      amountCents: input.amountCents,
      recipientAddress: input.recipientAddress,
      chainId: input.chainId ?? 8453,
      limitCurrency: input.limitCurrency ?? 'USD',
      description: input.description,
      resource: input.resource,
    })) as X402AuthorizeResponse;
  }

  /**
   * Poll an x402 authorization until the user approves on their phone
   * and the signed payload is ready.
   *
   * @returns The signed payload (Base64) for use as PAYMENT-SIGNATURE header.
   * @throws On denial, expiry, or timeout.
   */
  async pollX402Authorization(
    authorizationId: string,
    opts?: { intervalMs?: number; timeoutMs?: number },
  ): Promise<X402PollResponse> {
    const intervalMs = opts?.intervalMs ?? 2000;
    const timeoutMs = opts?.timeoutMs ?? 120_000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const res = (await this.request(
        'GET',
        `/v1/x402/authorize/${encodeURIComponent(authorizationId)}`,
      )) as X402PollResponse;

      if (res.status === 'signed' && res.signedPayload) {
        return res;
      }
      if (res.status === 'failed' || res.status === 'expired') {
        throw new Error(`x402 authorization ${res.status}`);
      }

      await new Promise((r) => setTimeout(r, intervalMs));
    }

    throw new Error('x402 authorization timed out waiting for approval');
  }

  /**
   * Get the agent's x402 payment wallet address on Base.
   */
  async getX402Wallet(): Promise<X402WalletInfo> {
    return (await this.request('GET', '/v1/x402/wallet')) as X402WalletInfo;
  }

  /**
   * Get the agent's x402 spending limits.
   */
  async getX402SpendingLimits(): Promise<{ limits: SpendingLimit[] }> {
    return (await this.request('GET', '/v1/x402/limits')) as { limits: SpendingLimit[] };
  }
}
