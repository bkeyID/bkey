// copyright © 2025-2026 bkey inc. all rights reserved.

import type { BKey } from './client.js';
import type { AccessStatus, CheckoutStatus, StoreStatus } from './types.js';

const POLL_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 120_000;

export async function pollAccessRequest(
  api: BKey,
  requestId: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<AccessStatus> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const res = (await api.getAccessRequestStatus(requestId)) as AccessStatus;

    if (res.status === 'consumed' || res.status === 'approved') {
      return res;
    }
    if (res.status === 'denied') {
      throw new Error('Access request was denied by the user.');
    }
    if (res.status === 'expired') {
      throw new Error('Access request expired before approval.');
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(`Access request timed out after ${timeoutMs / 1000}s.`);
}

export async function pollStoreRequest(
  api: BKey,
  requestId: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<StoreStatus> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const raw = (await api.getStoreRequestStatus(requestId)) as { storeRequest?: StoreStatus } & StoreStatus;
    const res = raw.storeRequest ?? raw;

    if (res.status === 'stored') {
      return res;
    }
    if (res.status === 'rejected') {
      throw new Error('Store request was rejected by the user.');
    }
    if (res.status === 'expired') {
      throw new Error('Store request expired before confirmation.');
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(`Store request timed out after ${timeoutMs / 1000}s.`);
}

export async function pollCheckoutRequest(
  api: BKey,
  requestId: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<CheckoutStatus> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const res = (await api.getCheckoutRequestStatus(requestId)) as { checkoutRequest: CheckoutStatus };
    const req = res.checkoutRequest;

    if (req.status === 'completed' || req.status === 'payment_completed') {
      return req;
    }
    if (req.status === 'payment_failed') {
      throw new Error('Payment failed. Check orderConfirmation for details.');
    }
    if (req.status === 'rejected') {
      throw new Error('Checkout was declined by the user.');
    }
    if (req.status === 'expired') {
      throw new Error('Checkout request expired before approval.');
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(`Checkout request timed out after ${timeoutMs / 1000}s.`);
}

// ─── x402 Payment Authorization Polling ──────────────────────────

import type { X402PollResponse } from './types.js';

/**
 * Standalone poll for x402 payment authorization.
 * Polls until the user approves on their phone and the signed payload is ready.
 *
 * @param apiUrl - BKey API base URL
 * @param token - OAuth access token
 * @param authorizationId - Authorization ID from POST /v1/x402/authorize
 * @param timeoutMs - Maximum wait time (default: 120s)
 * @returns Signed payload for use as PAYMENT-SIGNATURE header
 */
export async function pollX402Authorization(
  apiUrl: string,
  token: string,
  authorizationId: string,
  timeoutMs = 120_000,
): Promise<X402PollResponse> {
  const deadline = Date.now() + timeoutMs;
  const url = `${apiUrl.replace(/\/$/, '')}/v1/x402/authorize/${encodeURIComponent(authorizationId)}`;

  while (Date.now() < deadline) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      throw new Error(`x402 poll error: ${res.status}`);
    }

    const data = (await res.json()) as X402PollResponse;

    if (data.status === 'signed' && data.signedPayload) {
      return data;
    }
    if (data.status === 'failed' || data.status === 'expired') {
      throw new Error(`x402 authorization ${data.status}`);
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  throw new Error(`x402 authorization timed out after ${timeoutMs / 1000}s`);
}
