/** OIDC discovery document fields @bkey/login relies on. */
export interface BkeyDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  registration_endpoint?: string;
  end_session_endpoint?: string;
  id_token_signing_alg_values_supported?: string[];
}

export interface RegisterClientOptions {
  /** bkey issuer base, e.g. `https://auth.bkey.id` (or staging). */
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
  redirectUris: string[];
  idTokenSignedResponseAlg: string;
}

export interface BkeyLoginConfig {
  /** bkey issuer base, e.g. `https://auth.bkey.id`. */
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
