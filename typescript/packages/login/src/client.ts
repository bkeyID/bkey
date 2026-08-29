import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  BkeyLoginError,
  type AuthorizationRequest,
  type BkeyDiscovery,
  type BkeyLoginConfig,
  type ClaimRegisteredClientOptions,
  type LoginResult,
  type RevokeTokenOptions,
  type RegisterClientOptions,
  type RegisteredClient,
  type RegisteredClientManagementOptions,
  type RegisteredClientMetadata,
  type RotateClientSecretOptions,
  type RotatedClientSecret,
  type UpdateRegisteredClientOptions,
  type UploadedClientLogo,
  type UploadRegisteredClientLogoOptions,
} from './types.js';

const DISCOVERY_PATH = '/.well-known/openid-configuration';
const REVOCATION_TIMEOUT_MS = 5_000;
const DISCOVERY_TIMEOUT_MS = 5_000;
const REGISTRATION_TIMEOUT_MS = 5_000;
const CLIENT_MANAGEMENT_TIMEOUT_MS = 5_000;
const MAX_CLIENT_LOGO_UPLOAD_BYTES = 256 * 1024;
// Production constructs registration_client_uri from the API audience even
// though its OIDC issuer is id.bkey.id. Keep this exception exact so a caller
// cannot send a management bearer token to an arbitrary cross-origin host.
const PRODUCTION_ISSUER_ORIGIN = 'https://id.bkey.id';
const PRODUCTION_MANAGEMENT_ORIGIN = 'https://api.bkey.id';

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

/** Constant-time string equality (length leak is fine — values are fixed-size). */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** True for loopback names and the full IPv4 127.0.0.0/8 loopback block. */
function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (normalized === 'localhost' || normalized === '::1') return true;
  const octets = normalized.split('.');
  return (
    octets.length === 4 &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255) &&
    octets[0] === '127'
  );
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const deadlineSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, deadlineSignal]) : deadlineSignal;
}

function parseUrl(url: string, what: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BkeyLoginError('invalid_endpoint', `${what} is not a valid URL`);
  }
  if (parsed.username || parsed.password) {
    throw new BkeyLoginError(
      'invalid_endpoint',
      `${what} must not contain embedded credentials`,
    );
  }
  return parsed;
}

/**
 * Endpoints taken from discovery must use HTTPS and live on the configured
 * issuer's origin. Plain HTTP is permitted only on a loopback host for local
 * development. This prevents credential exposure through a tampered or
 * insecure discovery document.
 */
function assertSecureSameOrigin(issuer: string, url: string, what: string): string {
  const endpoint = parseUrl(url, what);
  if (
    endpoint.protocol !== 'https:' &&
    !(endpoint.protocol === 'http:' && isLoopbackHostname(endpoint.hostname))
  ) {
    throw new BkeyLoginError(
      'discovery_endpoint_insecure',
      `${what} must use HTTPS (HTTP is allowed only for loopback development)`,
    );
  }
  if (endpoint.origin !== new URL(issuer).origin) {
    throw new BkeyLoginError(
      'discovery_endpoint_off_origin',
      `${what} origin (${endpoint.origin}) is not on the issuer origin (${new URL(issuer).origin})`,
    );
  }
  return url;
}

function optionalString(
  body: Record<string, unknown>,
  field: string,
  errorCode: string,
): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new BkeyLoginError(errorCode, `response field ${field} must be a non-empty string`);
  }
  return value;
}

function optionalNumber(
  body: Record<string, unknown>,
  field: string,
  errorCode: string,
): number | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BkeyLoginError(errorCode, `response field ${field} must be a finite number`);
  }
  return value;
}

function stringArray(
  body: Record<string, unknown>,
  field: string,
  errorCode: string,
  fallback: string[] = [],
): string[] {
  const value = body[field];
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new BkeyLoginError(errorCode, `response field ${field} must be an array of strings`);
  }
  return value;
}

function requiredString(
  body: Record<string, unknown>,
  field: string,
  errorCode: string,
): string {
  if (typeof body[field] !== 'string' || body[field].length === 0) {
    throw new BkeyLoginError(errorCode, `response is missing ${field}`);
  }
  return body[field];
}

function requiredNumber(
  body: Record<string, unknown>,
  field: string,
  errorCode: string,
): number {
  const value = body[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BkeyLoginError(errorCode, `response is missing ${field}`);
  }
  return value;
}

function clientLogoUriFrom(
  body: Record<string, unknown>,
  errorCode: string,
  required = false,
): string | undefined {
  const value = required
    ? requiredString(body, 'logo_uri', errorCode)
    : optionalString(body, 'logo_uri', errorCode);
  if (value === undefined) return undefined;

  let url: URL;
  try {
    url = parseUrl(value, 'logo_uri');
  } catch {
    throw new BkeyLoginError(
      errorCode,
      'response field logo_uri must be a valid URL without embedded credentials',
    );
  }
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))
  ) {
    throw new BkeyLoginError(
      errorCode,
      'response field logo_uri must use HTTPS (HTTP is allowed only for loopback development)',
    );
  }
  return url.href;
}

function checkedClientLogoBody(logoPng: unknown): Blob | Uint8Array<ArrayBuffer> {
  const isBlob = typeof Blob !== 'undefined' && logoPng instanceof Blob;
  if (!(logoPng instanceof Uint8Array) && !isBlob) {
    throw new BkeyLoginError(
      'invalid_client_logo',
      'logoPng must be a Blob or Uint8Array containing raw PNG data',
    );
  }

  const size = logoPng instanceof Uint8Array ? logoPng.byteLength : logoPng.size;
  if (size < 1 || size > MAX_CLIENT_LOGO_UPLOAD_BYTES) {
    throw new BkeyLoginError(
      'invalid_client_logo',
      `logoPng must contain 1 to ${MAX_CLIENT_LOGO_UPLOAD_BYTES} bytes`,
    );
  }
  return logoPng instanceof Uint8Array ? Uint8Array.from(logoPng) : logoPng;
}

function clientMetadataFrom(body: Record<string, unknown>): RegisteredClientMetadata {
  const errorCode = 'invalid_client_management_response';
  return {
    clientId: requiredString(body, 'client_id', errorCode),
    registrationClientUri: requiredString(
      body,
      'registration_client_uri',
      errorCode,
    ),
    registrationAccessToken: optionalString(body, 'registration_access_token', errorCode),
    clientSecret: optionalString(body, 'client_secret', errorCode),
    clientSecretExpiresAt: optionalNumber(body, 'client_secret_expires_at', errorCode),
    clientName: optionalString(body, 'client_name', errorCode),
    logoUri: clientLogoUriFrom(body, errorCode),
    redirectUris: stringArray(body, 'redirect_uris', errorCode),
    postLogoutRedirectUris: stringArray(body, 'post_logout_redirect_uris', errorCode),
    grantTypes: stringArray(body, 'grant_types', errorCode),
    responseTypes: stringArray(body, 'response_types', errorCode),
    tokenEndpointAuthMethod: optionalString(body, 'token_endpoint_auth_method', errorCode),
    idTokenSignedResponseAlg: optionalString(body, 'id_token_signed_response_alg', errorCode),
    scope: optionalString(body, 'scope', errorCode),
  };
}

function responseError(
  body: Record<string, unknown>,
  fallbackCode: string,
  fallbackMessage: string,
): BkeyLoginError {
  const nested = body.error;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const error = nested as Record<string, unknown>;
    return new BkeyLoginError(
      typeof error.code === 'string' ? error.code : fallbackCode,
      typeof error.message === 'string' ? error.message : fallbackMessage,
    );
  }
  return new BkeyLoginError(
    typeof body.error === 'string' ? body.error : fallbackCode,
    typeof body.error_description === 'string' ? body.error_description : fallbackMessage,
  );
}

function assertSecureManagementUri(issuer: string, registrationClientUri: string): URL {
  const url = parseUrl(registrationClientUri, 'registration_client_uri');
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))
  ) {
    throw new BkeyLoginError(
      'discovery_endpoint_insecure',
      'registration_client_uri must use HTTPS (HTTP is allowed only for loopback development)',
    );
  }

  const issuerOrigin = new URL(issuer).origin;
  const isProductionManagementOrigin =
    issuerOrigin === PRODUCTION_ISSUER_ORIGIN &&
    url.origin === PRODUCTION_MANAGEMENT_ORIGIN;
  if (url.origin !== issuerOrigin && !isProductionManagementOrigin) {
    throw new BkeyLoginError(
      'discovery_endpoint_off_origin',
      `registration_client_uri origin (${url.origin}) is not trusted for issuer origin (${issuerOrigin})`,
    );
  }
  return url;
}

function clientManagementEndpoint(
  issuer: string,
  registrationClientUri: string,
  suffix = '',
): string {
  const url = assertSecureManagementUri(issuer, registrationClientUri);
  if (url.hash) {
    throw new BkeyLoginError(
      'invalid_registration_client_uri',
      'registration_client_uri must not contain a fragment',
    );
  }
  if (suffix && url.search) {
    throw new BkeyLoginError(
      'invalid_registration_client_uri',
      'query-based registration_client_uri values do not support BKey extension paths',
    );
  }
  if (suffix) {
    url.pathname = `${url.pathname.replace(/\/+$/, '')}${suffix}`;
  }
  return url.toString();
}

async function clientManagementRequest(
  opts: {
    issuer: string;
    registrationClientUri: string;
    accessToken: string;
    signal?: AbortSignal;
  },
  operation: string,
  method: 'GET' | 'PATCH' | 'POST' | 'PUT' | 'DELETE',
  suffix = '',
  requestBody?: {
    contentType: 'application/json' | 'image/png';
    body: BodyInit;
  },
): Promise<Record<string, unknown>> {
  const signal = requestSignal(opts.signal, CLIENT_MANAGEMENT_TIMEOUT_MS);
  const endpoint = clientManagementEndpoint(opts.issuer, opts.registrationClientUri, suffix);
  const res = await fetch(endpoint, {
    method,
    redirect: 'error',
    signal,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${opts.accessToken}`,
      ...(requestBody ? { 'content-type': requestBody.contentType } : {}),
    },
    ...(requestBody ? { body: requestBody.body } : {}),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw responseError(
      body,
      `${operation}_failed`,
      `${operation} failed: HTTP ${res.status}`,
    );
  }
  return body;
}

function managementRequestOptions(opts: RegisteredClientManagementOptions) {
  return {
    issuer: opts.issuer,
    registrationClientUri: opts.registrationClientUri,
    accessToken: opts.managementAccessToken,
    signal: opts.signal,
  };
}

async function fetchDiscovery(issuer: string, signal?: AbortSignal): Promise<BkeyDiscovery> {
  const boundedSignal = requestSignal(signal, DISCOVERY_TIMEOUT_MS);
  const res = await fetch(`${issuer.replace(/\/$/, '')}${DISCOVERY_PATH}`, {
    signal: boundedSignal,
    redirect: 'error',
    headers: { accept: 'application/json' },
  });
  if (!res.ok) {
    throw new BkeyLoginError('discovery_failed', `discovery fetch failed: HTTP ${res.status}`);
  }
  const doc = (await res.json()) as BkeyDiscovery;
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    throw new BkeyLoginError(
      'discovery_incomplete',
      'issuer discovery document is missing authorization/token/jwks endpoints — is Login with bkey enabled on this environment?',
    );
  }
  // OIDC Discovery §4.3: the document's self-declared issuer MUST equal the
  // issuer the client was configured with. Without this check, every later
  // `iss` validation would anchor to a value the (possibly tampered or
  // misconfigured) document chose for itself.
  if (doc.issuer.replace(/\/$/, '') !== issuer.replace(/\/$/, '')) {
    throw new BkeyLoginError(
      'issuer_mismatch',
      `discovery issuer "${doc.issuer}" does not match configured issuer "${issuer}"`,
    );
  }
  // Pin EVERY endpoint to the issuer origin here, once, so no consumer can be
  // tricked into sending traffic (the auth code + client_secret + PKCE verifier
  // on the token endpoint especially) to an attacker host advertised by a
  // tampered discovery document. The issuer-equality check above only pins the
  // document's self-declared `issuer`, not the individual endpoint URLs.
  assertSecureSameOrigin(issuer, doc.authorization_endpoint, 'authorization_endpoint');
  assertSecureSameOrigin(issuer, doc.token_endpoint, 'token_endpoint');
  if (doc.revocation_endpoint) {
    assertSecureSameOrigin(issuer, doc.revocation_endpoint, 'revocation_endpoint');
  }
  assertSecureSameOrigin(issuer, doc.jwks_uri, 'jwks_uri');
  if (doc.registration_endpoint) {
    assertSecureSameOrigin(issuer, doc.registration_endpoint, 'registration_endpoint');
  }
  if (doc.end_session_endpoint) {
    assertSecureSameOrigin(issuer, doc.end_session_endpoint, 'end_session_endpoint');
  }
  return doc;
}

/**
 * Self-serve client registration (RFC 7591) — no account, no dashboard:
 *
 * ```ts
 * const { clientId, clientSecret } = await registerClient({
 *   issuer: 'https://id.bkey.id',
 *   redirectUris: ['https://yourapp.com/auth/callback/bkey'],
 *   clientName: 'Your App',
 * });
 * ```
 *
 * Store the returned secret like a password — it is shown exactly once.
 */
export async function registerClient(opts: RegisterClientOptions): Promise<RegisteredClient> {
  const signal = requestSignal(opts.signal, REGISTRATION_TIMEOUT_MS);
  const discovery = await fetchDiscovery(opts.issuer, signal);
  if (!discovery.registration_endpoint) {
    throw new BkeyLoginError(
      'registration_unavailable',
      'this bkey environment does not advertise a registration_endpoint',
    );
  }
  assertSecureSameOrigin(opts.issuer, discovery.registration_endpoint, 'registration_endpoint');
  const res = await fetch(discovery.registration_endpoint, {
    method: 'POST',
    redirect: 'error',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: opts.redirectUris,
      ...(opts.postLogoutRedirectUris
        ? { post_logout_redirect_uris: opts.postLogoutRedirectUris }
        : {}),
      ...(opts.clientName ? { client_name: opts.clientName } : {}),
      // bkey's token endpoint reads credentials from the form body
      // (discovery advertises client_secret_post) — default to match.
      token_endpoint_auth_method: opts.tokenEndpointAuthMethod ?? 'client_secret_post',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      scope: 'openid',
    }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status !== 201 && res.status !== 200) {
    throw responseError(
      body,
      'registration_failed',
      `registration failed: HTTP ${res.status}`,
    );
  }
  const errorCode = 'invalid_registration_response';
  const tokenEndpointAuthMethod =
    optionalString(body, 'token_endpoint_auth_method', errorCode) ??
    opts.tokenEndpointAuthMethod ??
    'client_secret_post';
  const clientSecret = optionalString(body, 'client_secret', errorCode);
  const clientSecretExpiresAt = optionalNumber(body, 'client_secret_expires_at', errorCode);
  if (tokenEndpointAuthMethod !== 'none' && !clientSecret) {
    throw new BkeyLoginError(errorCode, 'response is missing client_secret');
  }
  if (clientSecret && clientSecretExpiresAt === undefined) {
    throw new BkeyLoginError(errorCode, 'response is missing client_secret_expires_at');
  }
  return {
    clientId: requiredString(body, 'client_id', errorCode),
    clientSecret,
    clientSecretExpiresAt,
    registrationClientUri: requiredString(
      body,
      'registration_client_uri',
      errorCode,
    ),
    registrationAccessToken: requiredString(body, 'registration_access_token', errorCode),
    clientName: optionalString(body, 'client_name', errorCode),
    logoUri: clientLogoUriFrom(body, errorCode),
    redirectUris: stringArray(body, 'redirect_uris', errorCode, opts.redirectUris),
    postLogoutRedirectUris: stringArray(
      body,
      'post_logout_redirect_uris',
      errorCode,
      opts.postLogoutRedirectUris ?? [],
    ),
    grantTypes: stringArray(body, 'grant_types', errorCode, ['authorization_code']),
    responseTypes: stringArray(body, 'response_types', errorCode, ['code']),
    tokenEndpointAuthMethod,
    idTokenSignedResponseAlg:
      optionalString(body, 'id_token_signed_response_alg', errorCode) ?? 'EdDSA',
    scope: optionalString(body, 'scope', errorCode) ?? 'openid',
  };
}

/** Read an existing dynamic client registration. */
export async function getRegisteredClient(
  opts: RegisteredClientManagementOptions,
): Promise<RegisteredClientMetadata> {
  const body = await clientManagementRequest(
    managementRequestOptions(opts),
    'client_registration_read',
    'GET',
  );
  return clientMetadataFrom(body);
}

/** Update the editable metadata for a dynamic client registration. */
export async function updateRegisteredClient(
  opts: UpdateRegisteredClientOptions,
): Promise<RegisteredClientMetadata> {
  const body = await clientManagementRequest(
    managementRequestOptions(opts),
    'client_registration_update',
    'PATCH',
    '',
    {
      contentType: 'application/json',
      body: JSON.stringify({
        ...(opts.redirectUris !== undefined ? { redirect_uris: opts.redirectUris } : {}),
        ...(opts.postLogoutRedirectUris !== undefined
          ? { post_logout_redirect_uris: opts.postLogoutRedirectUris }
          : {}),
        ...(opts.clientName !== undefined ? { client_name: opts.clientName } : {}),
        ...(opts.idTokenSignedResponseAlg !== undefined
          ? { id_token_signed_response_alg: opts.idTokenSignedResponseAlg }
          : {}),
      }),
    },
  );
  return clientMetadataFrom(body);
}

/** Upload or replace the PNG logo for a dynamic client registration. */
export async function uploadRegisteredClientLogo(
  opts: UploadRegisteredClientLogoOptions,
): Promise<UploadedClientLogo> {
  const logoPng = checkedClientLogoBody(opts.logoPng);
  const body = await clientManagementRequest(
    managementRequestOptions(opts),
    'client_logo_upload',
    'PUT',
    '/logo',
    { contentType: 'image/png', body: logoPng },
  );
  return {
    logoUri: clientLogoUriFrom(body, 'invalid_client_logo_response', true)!,
  };
}

/** Rotate a confidential client's secret. The new secret is returned once. */
export async function rotateClientSecret(
  opts: RotateClientSecretOptions,
): Promise<RotatedClientSecret> {
  const body = await clientManagementRequest(
    managementRequestOptions(opts),
    'client_secret_rotation',
    'POST',
    '/rotate-secret',
    {
      contentType: 'application/json',
      body: JSON.stringify({ grace_hours: opts.graceHours ?? 24 }),
    },
  );
  return {
    clientId: requiredString(body, 'client_id', 'invalid_client_management_response'),
    clientSecret: requiredString(body, 'client_secret', 'invalid_client_management_response'),
    clientSecretExpiresAt: requiredNumber(
      body,
      'client_secret_expires_at',
      'invalid_client_management_response',
    ),
    oldSecretExpiresAt: (() => {
      const value = body.old_secret_expires_at;
      if (value === null) return null;
      if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return value;
      throw new BkeyLoginError(
        'invalid_client_management_response',
        'response field old_secret_expires_at must be an ISO timestamp or null',
      );
    })(),
  };
}

/** Revoke and deprovision a dynamic client registration. */
export async function deleteRegisteredClient(
  opts: RegisteredClientManagementOptions,
): Promise<void> {
  await clientManagementRequest(
    managementRequestOptions(opts),
    'client_registration_delete',
    'DELETE',
  );
}

/** Claim an anonymous registration for the authenticated user or developer. */
export async function claimRegisteredClient(
  opts: ClaimRegisteredClientOptions,
): Promise<RegisteredClientMetadata> {
  const body = await clientManagementRequest(
    {
      issuer: opts.issuer,
      registrationClientUri: opts.registrationClientUri,
      accessToken: opts.ownerAccessToken,
      signal: opts.signal,
    },
    'client_registration_claim',
    'POST',
    '/claim',
    {
      contentType: 'application/json',
      body: JSON.stringify({ registration_access_token: opts.registrationAccessToken }),
    },
  );
  return clientMetadataFrom(body);
}

/**
 * Login with bkey — framework-agnostic OIDC authorization-code + PKCE helper.
 *
 * ```ts
 * const bkey = createBkeyLogin({ issuer, clientId, clientSecret, redirectUri });
 *
 * // 1. start sign-in: persist state/nonce/codeVerifier, redirect to url
 * const auth = await bkey.authorizationUrl();
 *
 * // 2. on your callback route:
 * const user = await bkey.handleCallback(callbackUrl, {
 *   state: auth.state, nonce: auth.nonce, codeVerifier: auth.codeVerifier,
 * });
 * console.log(user.sub); // the user's stable pseudonymous bkey ID
 * ```
 *
 * The id_token signature is verified against bkey's published JWKS (EdDSA),
 * plus issuer / audience / nonce / expiry — all before any claim is returned.
 */
export function createBkeyLogin(config: BkeyLoginConfig) {
  let discoveryDocument: BkeyDiscovery | null = null;
  let discoveryPromise: Promise<BkeyDiscovery> | null = null;
  let jwksCache: ReturnType<typeof createRemoteJWKSet> | null = null;

  const discovery = (signal?: AbortSignal): Promise<BkeyDiscovery> => {
    if (discoveryDocument) return Promise.resolve(discoveryDocument);

    // A signal-specific operation must control its own discovery request. Do
    // not attach it to an unbounded discovery request that another operation
    // might already have started.
    if (signal) {
      return fetchDiscovery(config.issuer, signal).then((doc) => {
        discoveryDocument = doc;
        return doc;
      });
    }

    if (!discoveryPromise) {
      discoveryPromise = fetchDiscovery(config.issuer).then(
        (doc) => {
          discoveryDocument = doc;
          discoveryPromise = null;
          return doc;
        },
        (error: unknown) => {
          discoveryPromise = null;
          throw error;
        },
      );
    }
    return discoveryPromise;
  };
  const jwks = async () => {
    if (!jwksCache) {
      const doc = await discovery();
      assertSecureSameOrigin(config.issuer, doc.jwks_uri, 'jwks_uri');
      jwksCache = createRemoteJWKSet(new URL(doc.jwks_uri));
    }
    return jwksCache;
  };

  const revokeToken = async (
    token: string,
    tokenTypeHint: 'access_token' | 'refresh_token',
    opts: RevokeTokenOptions = {},
  ): Promise<void> => {
    // Start one deadline at method entry and compose it with caller
    // cancellation. The same signal bounds discovery and the revocation POST.
    const deadlineSignal = AbortSignal.timeout(REVOCATION_TIMEOUT_MS);
    const signal = opts.signal
      ? AbortSignal.any([opts.signal, deadlineSignal])
      : deadlineSignal;
    const doc = await discovery(signal);
    if (!doc.revocation_endpoint) {
      throw new BkeyLoginError(
        'revocation_unavailable',
        'this bkey environment does not advertise a revocation_endpoint',
      );
    }
    const endpoint = assertSecureSameOrigin(
      config.issuer,
      doc.revocation_endpoint,
      'revocation_endpoint',
    );
    const res = await fetch(endpoint, {
      method: 'POST',
      // Do not let a same-origin endpoint forward the token or client secret.
      redirect: 'error',
      signal,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token,
        token_type_hint: tokenTypeHint,
        client_id: config.clientId,
        ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
      }).toString(),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      throw new BkeyLoginError(
        String(body.error ?? 'token_revocation_failed'),
        String(body.error_description ?? `token revocation failed: HTTP ${res.status}`),
      );
    }
  };

  return {
    /** Build the sign-in redirect. Persist state/nonce/codeVerifier until the callback. */
    async authorizationUrl(opts: { scope?: string } = {}): Promise<AuthorizationRequest> {
      const doc = await discovery();
      const state = b64url(randomBytes(24));
      const nonce = b64url(randomBytes(24));
      const codeVerifier = b64url(randomBytes(48));
      const challenge = b64url(createHash('sha256').update(codeVerifier).digest());
      const url = new URL(doc.authorization_endpoint);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', config.clientId);
      url.searchParams.set('redirect_uri', config.redirectUri);
      url.searchParams.set('scope', opts.scope ?? 'openid');
      url.searchParams.set('state', state);
      url.searchParams.set('nonce', nonce);
      url.searchParams.set('code_challenge', challenge);
      url.searchParams.set('code_challenge_method', 'S256');
      return { url: url.toString(), state, nonce, codeVerifier };
    },

    /**
     * Handle the redirect back from bkey: validates state, exchanges the code
     * (with PKCE), and verifies the id_token before returning the user.
     */
    async handleCallback(
      callbackUrl: string | URL,
      expected: { state: string; nonce: string; codeVerifier: string },
    ): Promise<LoginResult> {
      const cb = new URL(callbackUrl);
      const err = cb.searchParams.get('error');
      if (err) {
        throw new BkeyLoginError(err, cb.searchParams.get('error_description') ?? err);
      }
      const code = cb.searchParams.get('code');
      const state = cb.searchParams.get('state');
      if (!code) throw new BkeyLoginError('missing_code', 'callback has no code parameter');
      if (!state || !safeEqual(state, expected.state)) {
        throw new BkeyLoginError('state_mismatch', 'callback state does not match — possible CSRF');
      }
      const doc = await discovery();
      const tokenRes = await fetch(doc.token_endpoint, {
        method: 'POST',
        // The token endpoint returns JSON and never redirects; refuse to follow
        // a 3xx so a (same-origin) endpoint can't bounce this POST — carrying the
        // code + client_secret + PKCE verifier — to an off-origin host.
        redirect: 'error',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: config.clientId,
          ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
          redirect_uri: config.redirectUri,
          code_verifier: expected.codeVerifier,
        }).toString(),
      });
      const tokens = (await tokenRes.json().catch(() => ({}))) as Record<string, unknown>;
      if (!tokenRes.ok || !tokens.id_token) {
        throw new BkeyLoginError(
          String(tokens.error ?? 'token_exchange_failed'),
          String(tokens.error_description ?? `token exchange failed: HTTP ${tokenRes.status}`),
        );
      }
      const idToken = String(tokens.id_token);
      const { payload } = await jwtVerify(idToken, await jwks(), {
        issuer: doc.issuer,
        audience: config.clientId,
        // Static known-safe allowlist, deliberately NOT derived from the
        // discovery document: a tampered doc must never be able to widen
        // the accepted algorithms (downgrade vector). bkey signs EdDSA —
        // exactly what every issuer advertises and the only key in its JWKS —
        // so the allowlist is exactly that. Accepting an alg the IdP cannot
        // produce widens the set for no reachable case.
        algorithms: ['EdDSA'],
        // jose validates `exp`/`nbf` only when present; OIDC REQUIRES `exp`
        // (and `iat`) on an id_token, so require them explicitly — otherwise
        // a token minted without `exp` would verify and never expire.
        requiredClaims: ['exp', 'iat'],
        // Tolerate small clock skew between the RP and the IdP (numeric
        // seconds — unambiguous across jose versions).
        clockTolerance: 30,
      });
      if (typeof payload.nonce !== 'string' || !safeEqual(payload.nonce, expected.nonce)) {
        throw new BkeyLoginError('nonce_mismatch', 'id_token nonce does not match — possible replay');
      }
      if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
        throw new BkeyLoginError('invalid_id_token', 'id_token has no subject');
      }
      return {
        sub: payload.sub,
        claims: payload as Record<string, unknown>,
        idToken,
        accessToken: tokens.access_token ? String(tokens.access_token) : undefined,
        refreshToken: tokens.refresh_token ? String(tokens.refresh_token) : undefined,
      };
    },

    /** Revoke only this access token. The full operation has a 5-second deadline. */
    async revokeAccessToken(token: string, opts: RevokeTokenOptions = {}): Promise<void> {
      return revokeToken(token, 'access_token', opts);
    },

    /** Revoke only this refresh token. The full operation has a 5-second deadline. */
    async revokeRefreshToken(token: string, opts: RevokeTokenOptions = {}): Promise<void> {
      return revokeToken(token, 'refresh_token', opts);
    },

    /** OIDC RP-Initiated Logout URL (redirect the browser here to sign out). */
    async endSessionUrl(opts: {
      idToken: string;
      postLogoutRedirectUri?: string;
      state?: string;
    }): Promise<string> {
      const doc = await discovery();
      if (!doc.end_session_endpoint) {
        throw new BkeyLoginError(
          'end_session_unavailable',
          'this bkey environment does not advertise an end_session_endpoint',
        );
      }
      const url = new URL(doc.end_session_endpoint);
      url.searchParams.set('id_token_hint', opts.idToken);
      if (opts.postLogoutRedirectUri) {
        url.searchParams.set('post_logout_redirect_uri', opts.postLogoutRedirectUri);
      }
      if (opts.state) url.searchParams.set('state', opts.state);
      return url.toString();
    },
  };
}

export type BkeyLogin = ReturnType<typeof createBkeyLogin>;
