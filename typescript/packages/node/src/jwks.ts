// copyright © 2025-2026 bkey inc. all rights reserved.

import { createLocalJWKSet, createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';

import type { BKeyAdvancedVerifyConfig, BKeyInlineJwks } from './types.js';
import { BKeyAuthError } from './types.js';

export type JWKSFetcher = JWTVerifyGetKey;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Validate an inline JWKS. Rejects anything that isn't an Ed25519 public key
 *  in the expected shape. Defense against the main inline-jwks forgery bypass:
 *  only actual EdDSA public keys can verify BKey tokens, and rejecting keys
 *  with a `d` field stops anyone from leaking a private key into a JWKS store. */
function validateInlineJwks(jwks: BKeyInlineJwks): void {
  if (!jwks || typeof jwks !== 'object' || !Array.isArray(jwks.keys)) {
    throw new BKeyAuthError('jwks_fetch_failed', 'Inline JWKS must be { keys: [...] }');
  }
  if (jwks.keys.length === 0) {
    throw new BKeyAuthError('jwks_fetch_failed', 'Inline JWKS has no keys');
  }
  if (jwks.keys.length > 10) {
    // Any realistic JWKS has 1-3 active keys; 10 is generous for rotation.
    // A much larger array would be a sign of misuse.
    throw new BKeyAuthError('jwks_fetch_failed', 'Inline JWKS has too many keys');
  }
  for (const key of jwks.keys) {
    if (!key || typeof key !== 'object') {
      throw new BKeyAuthError('jwks_fetch_failed', 'Each inline JWK must be an object');
    }
    if ((key as { kty?: unknown }).kty !== 'OKP') {
      throw new BKeyAuthError(
        'jwks_fetch_failed',
        'Each inline JWK must have kty="OKP" (Ed25519)',
      );
    }
    if ((key as { crv?: unknown }).crv !== 'Ed25519') {
      throw new BKeyAuthError(
        'jwks_fetch_failed',
        'Each inline JWK must have crv="Ed25519"',
      );
    }
    const x = (key as { x?: unknown }).x;
    if (typeof x !== 'string' || x.length === 0) {
      throw new BKeyAuthError(
        'jwks_fetch_failed',
        'Each inline JWK must have a base64url-encoded "x" public key',
      );
    }
    if ('d' in key) {
      // Private-key field in a public JWKS is either a bug or a compromise.
      // Refuse outright.
      throw new BKeyAuthError(
        'jwks_fetch_failed',
        'Inline JWK must not contain a "d" (private key) field',
      );
    }
  }
}

/**
 * Create a JWKS fetcher.
 *
 * - If `config.jwks` is provided, uses it directly (no network). The JWKS
 *   is validated to contain only EdDSA (Ed25519) public keys.
 * - Otherwise, fetches from `config.jwksUrl` or `${issuer}/oauth/jwks`.
 *
 * The remote fetcher caches keys for `jwksCacheMaxAge` seconds (default 3600)
 * and handles key rotation via jose's internal cooldown mechanism.
 *
 * The JWKS URL must use HTTPS, except for `http://localhost` (for tests).
 * Issuer and jwksUrl are rejected if they contain control characters.
 */
export function createJwksFetcher(config: BKeyAdvancedVerifyConfig = {}): JWKSFetcher {
  // If a pre-built JWKS is provided, validate and use it directly — no network.
  if (config.jwks) {
    validateInlineJwks(config.jwks);
    return createLocalJWKSet(config.jwks as unknown as Parameters<typeof createLocalJWKSet>[0]);
  }

  const rawIssuer = config.issuer ?? 'https://api.bkey.id';
  if (typeof rawIssuer !== 'string' || CONTROL_CHARS.test(rawIssuer)) {
    throw new BKeyAuthError('jwks_fetch_failed', 'issuer contains invalid characters');
  }
  const issuer = rawIssuer.replace(/\/+$/, '');
  // Validate issuer is a parseable HTTPS URL (or localhost http for tests).
  try {
    const iss = new URL(issuer);
    if (
      iss.protocol !== 'https:' &&
      !(iss.protocol === 'http:' && (iss.hostname === 'localhost' || iss.hostname === '127.0.0.1'))
    ) {
      throw new BKeyAuthError(
        'jwks_fetch_failed',
        'issuer must be an https:// URL (http://localhost allowed for tests)',
      );
    }
  } catch (err) {
    if (err instanceof BKeyAuthError) throw err;
    throw new BKeyAuthError('jwks_fetch_failed', 'issuer is not a valid URL');
  }

  const jwksUrl = config.jwksUrl ?? `${issuer}/oauth/jwks`;
  if (typeof jwksUrl !== 'string' || CONTROL_CHARS.test(jwksUrl)) {
    throw new BKeyAuthError('jwks_fetch_failed', 'jwksUrl contains invalid characters');
  }

  if (
    config.jwksCacheMaxAge !== undefined &&
    (typeof config.jwksCacheMaxAge !== 'number' ||
      !Number.isFinite(config.jwksCacheMaxAge) ||
      config.jwksCacheMaxAge < 0)
  ) {
    throw new BKeyAuthError(
      'jwks_fetch_failed',
      'jwksCacheMaxAge must be a non-negative finite number (seconds)',
    );
  }
  const cacheMaxAge = (config.jwksCacheMaxAge ?? 3600) * 1000;

  let url: URL;
  try {
    url = new URL(jwksUrl);
  } catch {
    // Never echo jwksUrl back in the error — it may contain attacker input.
    throw new BKeyAuthError('jwks_fetch_failed', 'jwksUrl is not a valid URL');
  }

  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'))
  ) {
    throw new BKeyAuthError(
      'jwks_fetch_failed',
      'jwksUrl must use https:// (http://localhost is allowed for tests)',
    );
  }

  return createRemoteJWKSet(url, { cacheMaxAge });
}
