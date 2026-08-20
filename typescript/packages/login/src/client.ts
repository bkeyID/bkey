import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  BkeyLoginError,
  type AuthorizationRequest,
  type BkeyDiscovery,
  type BkeyLoginConfig,
  type LoginResult,
  type RevokeTokenOptions,
  type RegisterClientOptions,
  type RegisteredClient,
} from './types.js';

const DISCOVERY_PATH = '/.well-known/openid-configuration';
const REVOCATION_TIMEOUT_MS = 5_000;

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

/**
 * Endpoints taken from discovery must use HTTPS and live on the configured
 * issuer's origin. Plain HTTP is permitted only on a loopback host for local
 * development. This prevents credential exposure through a tampered or
 * insecure discovery document.
 */
function assertSecureSameOrigin(issuer: string, url: string, what: string): string {
  const endpoint = new URL(url);
  if (
    endpoint.protocol !== 'https:' &&
    !(endpoint.protocol === 'http:' && isLoopbackHostname(endpoint.hostname))
  ) {
    throw new BkeyLoginError(
      'discovery_endpoint_insecure',
      `${what} (${url}) must use HTTPS (HTTP is allowed only for loopback development)`,
    );
  }
  if (endpoint.origin !== new URL(issuer).origin) {
    throw new BkeyLoginError(
      'discovery_endpoint_off_origin',
      `${what} (${url}) is not on the issuer origin (${issuer})`,
    );
  }
  return url;
}

async function fetchDiscovery(issuer: string): Promise<BkeyDiscovery> {
  const res = await fetch(`${issuer.replace(/\/$/, '')}${DISCOVERY_PATH}`, {
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
  const discovery = await fetchDiscovery(opts.issuer);
  if (!discovery.registration_endpoint) {
    throw new BkeyLoginError(
      'registration_unavailable',
      'this bkey environment does not advertise a registration_endpoint',
    );
  }
  assertSecureSameOrigin(opts.issuer, discovery.registration_endpoint, 'registration_endpoint');
  const res = await fetch(discovery.registration_endpoint, {
    method: 'POST',
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
    throw new BkeyLoginError(
      String(body.error ?? 'registration_failed'),
      String(body.error_description ?? `registration failed: HTTP ${res.status}`),
    );
  }
  return {
    clientId: String(body.client_id),
    clientSecret: body.client_secret ? String(body.client_secret) : undefined,
    redirectUris: (body.redirect_uris as string[]) ?? opts.redirectUris,
    idTokenSignedResponseAlg: String(body.id_token_signed_response_alg ?? 'EdDSA'),
  };
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
  let discoveryPromise: Promise<BkeyDiscovery> | null = null;
  let jwksCache: ReturnType<typeof createRemoteJWKSet> | null = null;

  const discovery = () => (discoveryPromise ??= fetchDiscovery(config.issuer));
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
    const doc = await discovery();
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
      signal: opts.signal ?? AbortSignal.timeout(REVOCATION_TIMEOUT_MS),
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

    /** Revoke only this access token. Times out after 5 seconds by default. */
    async revokeAccessToken(token: string, opts: RevokeTokenOptions = {}): Promise<void> {
      return revokeToken(token, 'access_token', opts);
    },

    /** Revoke only this refresh token. Times out after 5 seconds by default. */
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
