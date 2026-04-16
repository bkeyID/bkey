// copyright © 2025-2026 bkey inc. all rights reserved.

// ─── Config ────────────────────────────────────────────────────────

export interface BKeyConfig {
  apiUrl: string;
  /** OAuth access token (EdDSA JWT). */
  accessToken?: string;
  /** OAuth refresh token (EdDSA JWT). */
  refreshToken?: string;
  /** ISO timestamp when the access token expires. */
  tokenExpiresAt?: string;
  /** The user's DID (decoded from the access token sub claim). */
  did?: string;
  /** Agent mode: OAuth client ID. */
  clientId?: string;
  /** Agent mode: OAuth client secret. */
  clientSecret?: string;
}

// ─── CIBA / Approval ───────────────────────────────────────────────

export interface ActionDetails {
  type: string;
  description: string;
  amount?: number;
  currency?: string;
  resource?: string;
  recipient?: string;
}

export interface CibaInitiateResponse {
  auth_req_id: string;
  expires_in: number;
  interval: number;
}

export interface CibaTokenResponse {
  access_token: string;
  expires_in: number;
  scope: string;
}

export interface ApprovalResult {
  approved: boolean;
  accessToken: string;
  scope: string;
  expiresIn: number;
}

// ─── Vault ─────────────────────────────────────────────────────────

export interface StoreRequestInput {
  itemType: string;
  name: string;
  description?: string;
  tags?: string[];
  website?: string;
  encryptedPayload: string;
  expiresInSecs?: number;
}

export interface AccessRequestInput {
  itemName: string;
  fieldPath: string;
  purpose: string;
  ephemeralPublicKey: string;
  expiresInSecs?: number;
}

export interface AccessStatus {
  id: string;
  status: string;
  e2eeCiphertext: string | null;
  expiresAt: string;
}

export interface StoreStatus {
  id: string;
  status: string;
}

// ─── Checkout ──────────────────────────────────────────────────────

export interface CheckoutRequestInput {
  merchantName: string;
  merchantDomain: string;
  checkoutUrl: string;
  amount: number;
  currency: string;
  lineItems: Array<{ title: string; quantity: number; price: number }>;
  expiresInSecs?: number;
}

export interface CheckoutStatus {
  id: string;
  status: string;
  orderConfirmation: Record<string, unknown> | null;
  approvedAt: string | null;
  completedAt: string | null;
  expiresAt: string;
}

// ─── x402 / MPP Payments ─────────────────────────────────────────

export interface X402AuthorizeInput {
  /** Amount in smallest currency unit (e.g. USD cents). */
  amountCents: number;
  /** Recipient EVM wallet address. */
  recipientAddress: string;
  /** EVM chain ID (default: 8453 = Base). */
  chainId?: number;
  /** Currency for limit check (default: 'USD'). */
  limitCurrency?: string;
  /** Human-readable description shown on approval screen. */
  description?: string;
  /** Resource URL this payment is for. */
  resource?: string;
}

export interface X402AuthorizeResponse {
  /** 'authorized' (signed immediately) or 'pending_approval' (CIBA initiated). */
  status: 'authorized' | 'pending_approval';
  /** Present when status = 'authorized'. */
  authorization?: X402SignedPayload;
  /** Present when status = 'pending_approval'. */
  authReqId?: string;
  authorizationId?: string;
  expiresIn?: number;
  interval?: number;
  message?: string;
}

export interface X402PollResponse {
  id: string;
  status: 'pending' | 'signed' | 'settled' | 'expired' | 'failed';
  /** Base64-encoded signed payload — use as PAYMENT-SIGNATURE header. */
  signedPayload?: string;
  /** Wallet address that signed the authorization. */
  fromAddress?: string;
  requiresBiometricApproval?: boolean;
}

export interface X402SignedPayload {
  signature: string;
  from: string;
  to: string;
  value: string;
  validAfter: number;
  validBefore: number;
  nonce: string;
  contractAddress: string;
  chainId: number;
  authorizationId: string;
  authorizationType: string;
}

export interface X402WalletInfo {
  address: string;
  chainId: number;
  network: string;
  asset: string;
  usdcContract: string;
}

export interface SpendingLimit {
  id: string;
  agentDid: string;
  dailyLimitAmount: number;
  monthlyLimitAmount: number;
  maxPerTransaction?: number;
  limitCurrency: string;
  dailySpent: number;
  monthlySpent: number;
}
