/** OIDC discovery document fields @bkey/login relies on. */
export interface BkeyDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint?: string;
  jwks_uri: string;
  registration_endpoint?: string;
  end_session_endpoint?: string;
  id_token_signing_alg_values_supported?: string[];
}

export interface RegisterClientOptions {
  /** bkey issuer base: `https://id.bkey.id` (or `https://staging-api.bkey.id`). */
  issuer: string;
  /** Where bkey may redirect back to after sign-in. */
  redirectUris: string[];
  /** Shown to users on the consent page. */
  clientName?: string;
  /** Allowlisted post-logout redirect targets (OIDC RP-Initiated Logout). */
  postLogoutRedirectUris?: string[];
  /**
   * `'client_secret_post'` (default — you get a secret back) or `'none'` for
   * public clients (SPAs / native) that rely on PKCE alone. NOT
   * `client_secret_basic`: createBkeyLogin / BkeyProvider always send the secret
   * in the form body and the bkey token endpoint only accepts client_secret_post,
   * so registering Basic would never authenticate (PR #32 review).
   */
  tokenEndpointAuthMethod?: 'client_secret_post' | 'none';
}

export interface RegisteredClient {
  clientId: string;
  /** Present only for confidential clients. Store it like a password. */
  clientSecret?: string;
  /** Unix timestamp when the client ID was issued. */
  clientIdIssuedAt: number;
  /** Unix timestamp when the client secret expires. `0` means no expiry. */
  clientSecretExpiresAt?: number;
  /** Per-client URI for all registration management operations. */
  registrationClientUri: string;
  /**
   * One-time credential for an anonymous client's management URI.
   * Store it separately from the client secret. It is not returned again.
   */
  registrationAccessToken?: string;
  clientName?: string;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  tokenEndpointAuthMethod: string;
  idTokenSignedResponseAlg: string;
  scope: string;
}

/** Client metadata returned by read, update, and claim operations. */
export interface RegisteredClientMetadata {
  clientId: string;
  clientIdIssuedAt: number;
  registrationClientUri: string;
  clientName: string;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  tokenEndpointAuthMethod: string;
  idTokenSignedResponseAlg: string;
  scope: string;
}

/** Authentication and location for an existing client registration. */
export interface RegisteredClientManagementOptions {
  /** The same issuer used to register the client. */
  issuer: string;
  /** The `registrationClientUri` returned during registration. */
  registrationClientUri: string;
  /**
   * The one-time registration token for an anonymous client, or the owner user
   * or developer-dashboard access token for an owned client. Never use the
   * OAuth client secret here.
   */
  managementAccessToken: string;
  /** Cancel the request. */
  signal?: AbortSignal;
}

export interface UpdateRegisteredClientOptions extends RegisteredClientManagementOptions {
  redirectUris?: string[];
  postLogoutRedirectUris?: string[];
  clientName?: string;
  idTokenSignedResponseAlg?: string;
}

export interface RotateClientSecretOptions extends RegisteredClientManagementOptions {
  /** Hours that old secrets stay valid. Defaults to 24. Use `0` after a leak. */
  graceHours?: number;
}

export interface RotatedClientSecret {
  clientId: string;
  /** The new secret. It is returned only once. */
  clientSecret: string;
  /** Unix timestamp when the new secret expires. `0` means no expiry. */
  clientSecretExpiresAt: number;
  /** ISO timestamp for old-secret expiry, or `null` when grace is disabled. */
  oldSecretExpiresAt: string | null;
}

export interface ClaimRegisteredClientOptions {
  /** The same issuer used to register the client. */
  issuer: string;
  /** The `registrationClientUri` returned during registration. */
  registrationClientUri: string;
  /** User or developer-dashboard access token for the new owner. */
  ownerAccessToken: string;
  /** One-time token returned when the anonymous client was registered. */
  registrationAccessToken: string;
  /** Cancel the request. */
  signal?: AbortSignal;
}

export interface BkeyLoginConfig {
  /** bkey issuer base: `https://id.bkey.id` (or `https://staging-api.bkey.id`). */
  issuer: string;
  clientId: string;
  /** Omit for public (PKCE-only) clients. */
  clientSecret?: string;
  /** The redirect_uri registered for this client. */
  redirectUri: string;
}

export interface AuthorizationRequest {
  /** Send the user's browser here. */
  url: string;
  /** Persist these three server-side (session/cookie) until the callback. */
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface RevokeTokenOptions {
  /** Cancel the full operation sooner. The 5-second deadline remains active. */
  signal?: AbortSignal;
}

export interface LoginResult {
  /**
   * The user's bkey ID — a stable pseudonymous DID. This is the identity.
   * v1 shares nothing else (no name/email).
   */
  sub: string;
  /** Full verified id_token claims. */
  claims: Record<string, unknown>;
  idToken: string;
  accessToken?: string;
  refreshToken?: string;
}

export class BkeyLoginError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'BkeyLoginError';
    this.code = code;
  }
}
