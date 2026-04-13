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
