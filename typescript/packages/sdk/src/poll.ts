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
