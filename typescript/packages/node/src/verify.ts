// copyright © 2025-2026 bkey inc. all rights reserved.

import { jwtVerify, errors as joseErrors } from 'jose';

import { createJwksFetcher, type JWKSFetcher } from './jwks.js';
import type { BKeyAuthClaims, VerifyTokenOptions } from './types.js';
import { BKeyAuthError } from './types.js';

const DEFAULT_ISSUER = 'https://api.bkey.id';
// Cap on raw token string length. JWTs of even 8 KB are very large; real
// BKey tokens are ~500-1500 bytes. This is a DoS backstop.
const MAX_TOKEN_LENGTH = 8192;
// Tight JWT charset: three base64url segments separated by dots, where the
// third (signature) segment must be non-empty — no alg=none, no whitespace,
// no smuggled comma-separated tokens.
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
// Accept lowercase Bearer too; require exactly one space between scheme and
// token. Reject anything containing non-JWT characters after the scheme.
const BEARER_HEADER = /^Bearer ([A-Za-z0-9_.-]+)$/i;
// Bounded LRU for JWKS fetchers. Prevents unbounded memory growth in
// multi-tenant deployments that pass caller-controlled issuer/jwksUrl.
const FETCHER_CACHE_MAX_ENTRIES = 50;
// Claim keys that could enable prototype pollution if copied onto a plain
// object. We strip these defensively even though we also use a null-prototype
// container — the stripped claims should never appear on `claims.*`.
const DANGEROUS_CLAIM_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const fetcherCache = new Map<string, JWKSFetcher>();

/** Normalize an issuer value: strip trailing slashes. Applied to both the
 *  configured issuer AND the `iss` claim on the token, so the equality check
 *  tolerates trailing-slash drift between the server and SDK config. */
function normalizeIssuer(issuer: string | undefined): string {
  return (issuer ?? DEFAULT_ISSUER).replace(/\/+$/, '');
}

function getFetcher(opts: VerifyTokenOptions, normalizedIssuer: string): JWKSFetcher {
  // When an inline JWKS is passed, skip the cache — the caller owns the
  // lifecycle of that JWKS and may pass different keys on each call.
  if (opts.jwks) {
    return createJwksFetcher(opts);
  }

  // Use NUL as a separator to avoid collisions from attacker-controlled config.
  const key = `${normalizedIssuer}\u0000${opts.jwksUrl ?? ''}\u0000${opts.jwksCacheMaxAge ?? ''}`;
  const existing = fetcherCache.get(key);
  if (existing) {
    // LRU touch — move recently-used entry to the most-recent end.
    fetcherCache.delete(key);
    fetcherCache.set(key, existing);
    return existing;
  }
  const fetcher = createJwksFetcher({ ...opts, issuer: normalizedIssuer });
  if (fetcherCache.size >= FETCHER_CACHE_MAX_ENTRIES) {
    const oldest = fetcherCache.keys().next().value;
    if (oldest !== undefined) fetcherCache.delete(oldest);
  }
  fetcherCache.set(key, fetcher);
  return fetcher;
}

/** For tests only. Clears the module-level fetcher cache. */
export function _resetFetcherCache(): void {
  fetcherCache.clear();
}

/** Validate caller-supplied options at entry. Returns nothing; throws on
 *  misconfiguration. The goal is to fail fast and loudly rather than silently
 *  accept unsafe defaults. */
function validateOpts(opts: VerifyTokenOptions): void {
  // Default-unsafe guard: if a caller passes no audience and no scope, they
  // accept any BKey-signed token — a confused-deputy footgun. Require that
  // the caller explicitly opts in (they can do `scope: []` for "any scope").
  if (opts.audience === undefined && opts.scope === undefined) {
    throw new BKeyAuthError(
      'insufficient_scope',
      'verifyToken requires at least one of { audience, scope } to prevent accepting ' +
        'tokens issued for other apps (confused-deputy). Pass scope: [] to explicitly ' +
        'accept any scope.',
    );
  }
  if (opts.clockTolerance !== undefined) {
    if (
      typeof opts.clockTolerance !== 'number' ||
      !Number.isFinite(opts.clockTolerance) ||
      opts.clockTolerance < 0
    ) {
      throw new BKeyAuthError(
        'invalid_signature',
        'clockTolerance must be a non-negative finite number (seconds)',
      );
    }
  }
  if (opts.audience !== undefined) {
    const aud = opts.audience;
    const valid =
      (typeof aud === 'string' && aud.length > 0) ||
      (Array.isArray(aud) && aud.every((a) => typeof a === 'string' && a.length > 0));
    if (!valid) {
      throw new BKeyAuthError(
        'invalid_audience',
        'audience must be a non-empty string or array of non-empty strings',
      );
    }
  }
}

/**
 * Verify a BKey JWT.
 *
 * Checks:
 *   - EdDSA signature via BKey's JWKS endpoint (Ed25519)
 *   - `iss` matches the configured issuer (trailing-slash tolerant)
 *   - `exp` / `nbf` against the current time (with optional skew tolerance)
 *   - `aud` matches the configured audience (if set)
 *   - All required scopes are present (if `opts.scope` is set)
 *   - `sub`, `iat`, `exp` are present and of the expected types
 *
 * Throws `BKeyAuthError` on any failure. On success, returns the verified
 * claims with a convenience `scopes` array alongside the raw `scope` string.
 *
 * **Security note:** You MUST pass at least one of `audience` or `scope`
 * to prevent accepting tokens issued for other apps. Pass `scope: []` to
 * explicitly accept any scope (you probably don't want this).
 *
 * @example
 * ```ts
 * import { verifyToken, BKeyAuthError } from '@bkey/node';
 *
 * try {
 *   const claims = await verifyToken(jwt, {
 *     issuer: 'https://api.bkey.id',
 *     audience: 'https://my-app.example',
 *     scope: 'approve:payment',
 *   });
 *   console.log(`Verified for user ${claims.sub}`);
 * } catch (err) {
 *   if (err instanceof BKeyAuthError) {
 *     console.error(`${err.code}: ${err.message}`);
 *   }
 * }
 * ```
 */
export async function verifyToken(
  token: string,
  opts: VerifyTokenOptions = {},
): Promise<BKeyAuthClaims> {
  validateOpts(opts);

  if (typeof token !== 'string' || token.length === 0) {
    throw new BKeyAuthError('malformed_token');
  }
  if (token.length > MAX_TOKEN_LENGTH) {
    throw new BKeyAuthError('malformed_token');
  }
  if (!JWT_SHAPE.test(token)) {
    throw new BKeyAuthError('malformed_token');
  }

  const issuer = normalizeIssuer(opts.issuer);
  const fetcher = getFetcher(opts, issuer);

  let payload: Record<string, unknown>;
  let protectedHeader: Record<string, unknown>;
  try {
    // Note: we DO NOT pass `issuer` to jose here. jose does an exact-match
    // check on `iss`, which would fail if the token's iss has a trailing
    // slash but the config doesn't (or vice versa). We do our own normalized
    // equality check after verify instead.
    const result = await jwtVerify(token, fetcher, {
      audience: opts.audience,
      clockTolerance: opts.clockTolerance ?? 30,
      algorithms: ['EdDSA'],
      requiredClaims: ['sub', 'iat', 'exp', 'iss'],
    });
    payload = result.payload as Record<string, unknown>;
    protectedHeader = result.protectedHeader as Record<string, unknown>;
  } catch (err) {
    throw mapJoseError(err);
  }

  // Belt-and-suspenders: jose already enforced `alg: ['EdDSA']`, but double
  // check the protected header to defend against any future jose regression.
  // We also check that the JWK used to verify was an Ed25519 key — EdDSA
  // could in principle be Ed448 too; BKey only uses Ed25519.
  if (protectedHeader.alg !== 'EdDSA') {
    throw new BKeyAuthError('invalid_signature');
  }

  // Validate claim types. jose's `requiredClaims` ensures presence; we also
  // need to ensure the values are the right type before handing them to user
  // code that assumes string claims.
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new BKeyAuthError('invalid_signature');
  }
  if (typeof payload.iat !== 'number' || typeof payload.exp !== 'number') {
    throw new BKeyAuthError('invalid_signature');
  }
  if (typeof payload.iss !== 'string' || payload.iss.length === 0) {
    throw new BKeyAuthError('invalid_signature');
  }
  // Optional claims — validate types if present so downstream code can trust
  // the TypeScript types we advertise.
  if ('nbf' in payload && typeof payload.nbf !== 'number') {
    throw new BKeyAuthError('invalid_signature');
  }
  if ('jti' in payload && typeof payload.jti !== 'string') {
    throw new BKeyAuthError('invalid_signature');
  }
  if ('client_id' in payload && typeof payload.client_id !== 'string') {
    throw new BKeyAuthError('invalid_signature');
  }
  if ('aud' in payload) {
    const aud = payload.aud;
    const valid =
      (typeof aud === 'string' && aud.length > 0) ||
      (Array.isArray(aud) && aud.every((a) => typeof a === 'string' && a.length > 0));
    if (!valid) {
      throw new BKeyAuthError('invalid_signature');
    }
  }

  // Trailing-slash-tolerant issuer check. Normalize both sides so the
  // SDK accepts tokens whether or not the server appends a trailing slash
  // to its issuer URL.
  const receivedIss = payload.iss.replace(/\/+$/, '');
  if (receivedIss !== issuer) {
    throw new BKeyAuthError('invalid_issuer');
  }

  // Scope claim MUST be a string if present. Silently coercing array-valued
  // scope to '' would hide tampering from downstream code.
  if ('scope' in payload && typeof payload.scope !== 'string') {
    throw new BKeyAuthError('invalid_signature');
  }
  const scope = (payload.scope as string | undefined) ?? '';
  const scopes = scope.length > 0 ? scope.split(/\s+/).filter(Boolean) : [];

  // Scope enforcement — require ALL scopes in opts.scope (AND semantics,
  // matching the backend's requireScope middleware). Reject empty-string
  // scopes at config time to avoid always-failing filters.
  if (opts.scope !== undefined) {
    const required = Array.isArray(opts.scope) ? opts.scope : [opts.scope];
    if (required.length > 0) {
      const hasEmpty = required.some((s) => typeof s !== 'string' || s.length === 0);
      if (hasEmpty) {
        throw new BKeyAuthError(
          'insufficient_scope',
          'Required scope list contains empty or non-string entries',
        );
      }
      const missing = required.filter((s) => !scopes.includes(s));
      if (missing.length > 0) {
        throw new BKeyAuthError('insufficient_scope');
      }
    }
    // An empty array means "explicitly accept any scope" — no enforcement.
  }

  // Build claims on a null-prototype container AND strip dangerous keys.
  // The combination defends against both direct access via `claims[k]`
  // (which could hit Object.prototype if prototype wasn't null) and
  // downstream re-spreading (`{ ...claims }`) that would put a __proto__
  // own property onto a normal object.
  const claims: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(payload)) {
    if (DANGEROUS_CLAIM_KEYS.has(k)) continue;
    claims[k] = v;
  }
  claims.scope = scope;
  claims.scopes = scopes;
  return claims as unknown as BKeyAuthClaims;
}

/**
 * Extract a Bearer token from an Authorization header.
 * Returns the raw JWT, or throws `BKeyAuthError` if the header is absent
 * or malformed. Rejects tokens containing whitespace or smuggled extra
 * content — JWTs are exactly three base64url segments.
 */
export function extractBearerToken(authHeader: string | undefined | null): string {
  if (typeof authHeader !== 'string' || authHeader.length === 0) {
    throw new BKeyAuthError('missing_token');
  }
  const match = BEARER_HEADER.exec(authHeader);
  if (!match) {
    throw new BKeyAuthError('malformed_token');
  }
  return match[1]!;
}

/** Strip decoded token content (`payload`, `claim`) off jose errors before
 *  attaching as `cause`. Application loggers that walk `error.cause` chains
 *  (pino, winston with errors-pretty) would otherwise serialize the full
 *  token payload — including PII — into application logs.
 *
 *  We preserve enough to debug (the error class name, code, message) but
 *  drop anything that can carry token claims or signing material. */
function sanitizeCause(err: unknown): Error | undefined {
  if (!(err instanceof Error)) return undefined;
  const safe = new Error(err.message);
  safe.name = err.name;
  // Intentionally do NOT copy err.stack (may include file paths + line
  // numbers that aren't useful to clients but are also not sensitive).
  // Intentionally do NOT copy err.code, err.payload, err.claim — the first
  // is generally safe but keeping parity with payload-stripping; the latter
  // two are the actual leakage vectors.
  return safe;
}

function mapJoseError(err: unknown): BKeyAuthError {
  if (err instanceof BKeyAuthError) return err;
  const cause = sanitizeCause(err);
  if (err instanceof joseErrors.JWTExpired) {
    return new BKeyAuthError('expired_token', undefined, cause);
  }
  if (err instanceof joseErrors.JWTClaimValidationFailed) {
    if (err.claim === 'aud') {
      return new BKeyAuthError('invalid_audience', undefined, cause);
    }
    return new BKeyAuthError('invalid_signature', undefined, cause);
  }
  // JWKS-related errors surface as jwks_fetch_failed so operators can
  // distinguish a BKey outage or network issue from a forged token.
  if (
    err instanceof joseErrors.JWKSNoMatchingKey ||
    err instanceof joseErrors.JWKSMultipleMatchingKeys ||
    err instanceof joseErrors.JWKSTimeout ||
    err instanceof joseErrors.JWKSInvalid
  ) {
    return new BKeyAuthError('jwks_fetch_failed', undefined, cause);
  }
  // All other jose errors map to invalid_signature with a canned message.
  return new BKeyAuthError('invalid_signature', undefined, cause);
}
