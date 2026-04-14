// copyright © 2025-2026 bkey inc. all rights reserved.

/**
 * Configuration for BKey token verification.
 */
export interface BKeyVerifyConfig {
  /**
   * The BKey issuer URL. Used for JWKS discovery and `iss` claim check.
   * @default "https://api.bkey.id"
   */
  issuer?: string;

  /**
   * Expected audience (`aud` claim). If set, tokens without a matching
   * audience are rejected. Leave undefined to skip audience checks.
   */
  audience?: string | string[];

  /**
   * Clock skew tolerance in seconds for `exp` / `nbf` checks.
   * @default 30
   */
  clockTolerance?: number;

  /**
   * JWKS cache TTL in seconds.
   * @default 3600
   */
  jwksCacheMaxAge?: number;

  /**
   * Override the JWKS URL. Normally derived from `issuer` + OIDC discovery.
   */
  jwksUrl?: string;

}

/**
 * Advanced options. These are intentionally separated from the main config
 * so that a shallow-spread of untrusted request data into `BKeyVerifyConfig`
 * cannot accidentally enable an inline JWKS — which would be a full forgery
 * bypass. Use this only with trusted, startup-time configuration.
 */
export interface BKeyAdvancedVerifyConfig extends BKeyVerifyConfig {
  /**
   * Provide a pre-built JWKS instead of fetching from a remote URL.
   * Useful for tests and for environments where the JWKS is already
   * cached (e.g., loaded from Redis at boot).
   *
   * SECURITY: setting this from caller-controlled data is a forgery
   * bypass. Only set this from trusted config. The SDK validates the
   * shape of each key and rejects any key containing `d` (private-key
   * component) as a defense-in-depth signal that something is wrong.
   */
  jwks?: BKeyInlineJwks;
}

/** Shape of an inline JWKS. Each key must be an Ed25519 JWK without `d`. */
export interface BKeyInlineJwks {
  keys: Array<{
    kty: 'OKP';
    crv: 'Ed25519';
    x: string;
    kid?: string;
    use?: 'sig';
    alg?: 'EdDSA';
    /** Must NOT be set. Private-key components never belong in a JWKS. */
    d?: never;
  }>;
}

/**
 * Verified claims extracted from a BKey JWT.
 *
 * Users get these on `req.bkeyAuth` after `requireBKeyAuth` middleware passes.
 */
export interface BKeyAuthClaims {
  /** Subject — the user's DID or OAuth client ID for machine-to-machine tokens. */
  sub: string;

  /** Issuer — will match the configured BKey issuer. */
  iss: string;

  /** Issued-at timestamp (unix seconds). */
  iat: number;

  /** Expiry timestamp (unix seconds). */
  exp: number;

  /** Space-separated list of granted scopes (empty string if none). */
  scope: string;

  /**
   * Array form of `scope` — convenient for scope checks.
   * Derived by splitting `scope` on whitespace; not present in the raw JWT.
   */
  scopes: string[];

  /** Audience claim (if present in the token). */
  aud?: string | string[];

  /** OAuth client ID (present for client_credentials and CIBA tokens). */
  client_id?: string;

  /** JWT ID. */
  jti?: string;

  /** Not-before timestamp (unix seconds). */
  nbf?: number;

  /** All other claims from the token — escape hatch for custom claims. */
  [key: string]: unknown;
}

/**
 * Options for verifying a single token.
 *
 * Extends the advanced config so that `jwks` is available — but the type
 * still requires conscious opt-in (via typing the options as
 * `BKeyAdvancedVerifyConfig` or using `verifyTokenUnsafe` for the
 * inline-JWKS path). Tests and trusted config code explicitly widen.
 */
export interface VerifyTokenOptions extends BKeyAdvancedVerifyConfig {
  /**
   * Required scope or scopes. If set, the token must have ALL of these scopes
   * to pass verification. Pass `string` for one scope, `string[]` for many.
   * Pass `[]` to explicitly accept any scope (satisfies the default-safe check
   * that at least one of audience or scope is configured).
   */
  scope?: string | string[];
}

export type BKeyAuthErrorCode =
  /** No Authorization header present. */
  | 'missing_token'
  /** Authorization header is not "Bearer <token>". */
  | 'malformed_token'
  /** JWT signature did not verify against BKey's JWKS. */
  | 'invalid_signature'
  /** Token is expired. */
  | 'expired_token'
  /** `iss` claim does not match the configured issuer. */
  | 'invalid_issuer'
  /** `aud` claim does not match the configured audience. */
  | 'invalid_audience'
  /** Token is valid but missing one of the required scopes. */
  | 'insufficient_scope'
  /** JWKS fetch failed (network error, etc). */
  | 'jwks_fetch_failed';

/** Stable, canned messages for every error code — never echo jose internals
 *  to the client, since error messages can contain claim values or infra detail. */
const ERROR_MESSAGES: Record<BKeyAuthErrorCode, string> = {
  missing_token: 'Authorization header is missing',
  malformed_token: 'Authorization header must be "Bearer <token>"',
  invalid_signature: 'Token signature did not verify',
  expired_token: 'Token has expired',
  invalid_issuer: 'Token was issued by an unexpected issuer',
  invalid_audience: 'Token audience does not match',
  insufficient_scope: 'Token is missing a required scope',
  jwks_fetch_failed: 'Failed to fetch signing keys',
};

/**
 * Thrown when token verification fails.
 * The `code` is stable and suitable for programmatic handling; `message`
 * is a canned, client-safe description.
 *
 * The original underlying error (if any) is attached as `cause` for
 * server-side logging — do NOT log the cause to client-visible surfaces,
 * since jose's internal messages may contain claim values.
 */
export class BKeyAuthError extends Error {
  public readonly code: BKeyAuthErrorCode;
  public readonly status: number;

  constructor(code: BKeyAuthErrorCode, message?: string, cause?: unknown) {
    super(message ?? ERROR_MESSAGES[code], cause ? { cause } : undefined);
    this.name = 'BKeyAuthError';
    this.code = code;
    this.status = code === 'insufficient_scope' ? 403 : 401;
  }
}
