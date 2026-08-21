import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { createHash } from 'node:crypto';
import {
  SignJWT,
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  type JWK,
} from 'jose';
import {
  claimRegisteredClient,
  createBkeyLogin,
  deleteRegisteredClient,
  getRegisteredClient,
  registerClient,
  rotateClientSecret,
  updateRegisteredClient,
} from './client.js';
import { BkeyLoginError } from './types.js';
import { BKEY_DEFAULT_ISSUER, BkeyProvider } from './authjs.js';

/**
 * Full-flow tests against an in-process mock bkey OP: discovery + JWKS +
 * RFC 7591 registration + token endpoint minting REAL EdDSA id_tokens. The
 * mock echoes the nonce it is given and records the PKCE verifier hash so
 * the tests can assert the SDK sent a correct S256 challenge.
 */

const PORT = 18583;
const ISSUER = `http://localhost:${PORT}`;
const CLIENT_ID = 'bkey_client_login_sdk';
const MANAGED_CLIENT_ID = 'bkey_client_fresh123';
const REGISTRATION_CLIENT_URI = `${ISSUER}/oauth/register/${MANAGED_CLIENT_ID}`;
const REDIRECT = 'https://rp.example/auth/callback/bkey';

let server: http.Server;
let edPrivate: CryptoKey;
let edJwk: JWK;
// A second, RSA key the mock OP can sign with — used only to prove the SDK
// refuses RS256 even when the discovery doc advertises it and the JWKS
// carries a matching key (bkey#53).
let rsaPrivate: CryptoKey;
let rsaJwk: JWK;
const opState: {
  nonce: string | null;
  lastCodeVerifier: string | null;
  lastCodeChallenge: string | null;
  tamperNonce: boolean;
  aud: string;
  omitExp: boolean;
  offOriginToken: boolean;
  signRs256: boolean;
  lastRevocation: URLSearchParams | null;
  rejectRevocation: boolean;
  hangDiscovery: boolean;
  hangRevocation: boolean;
  rejectManagement: boolean;
  managementRequests: Array<{
    method: string;
    path: string;
    authorization?: string;
    body?: Record<string, unknown>;
  }>;
} = {
  nonce: null,
  lastCodeVerifier: null,
  lastCodeChallenge: null,
  tamperNonce: false,
  aud: CLIENT_ID,
  omitExp: false,
  offOriginToken: false,
  signRs256: false,
  lastRevocation: null,
  rejectRevocation: false,
  hangDiscovery: false,
  hangRevocation: false,
  rejectManagement: false,
  managementRequests: [],
};

beforeAll(async () => {
  // jose v5 names the keygen alg 'EdDSA' (v6 renamed it 'Ed25519').
  const kp = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  edPrivate = kp.privateKey as CryptoKey;
  edJwk = await exportJWK(kp.publicKey);
  edJwk.kid = await calculateJwkThumbprint(edJwk, 'sha256');
  edJwk.use = 'sig';
  edJwk.alg = 'EdDSA';

  const rsaKp = await generateKeyPair('RS256', { extractable: true });
  rsaPrivate = rsaKp.privateKey as CryptoKey;
  rsaJwk = await exportJWK(rsaKp.publicKey);
  rsaJwk.kid = await calculateJwkThumbprint(rsaJwk, 'sha256');
  rsaJwk.use = 'sig';
  rsaJwk.alg = 'RS256';

  server = http.createServer(async (req, res) => {
    const send = (status: number, obj: unknown) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(obj));
    };
    const url = new URL(req.url!, ISSUER);
    if (url.pathname === '/.well-known/openid-configuration') {
      if (opState.hangDiscovery) return;
      return send(200, {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/oauth/authorize`,
        // A tampered discovery doc that keeps a valid `issuer` but points the
        // token endpoint at an attacker host (credential-exfil vector).
        token_endpoint: opState.offOriginToken
          ? 'https://evil.example.com/oauth/token'
          : `${ISSUER}/oauth/token`,
        revocation_endpoint: `${ISSUER}/oauth/revoke`,
        jwks_uri: `${ISSUER}/oauth/jwks`,
        registration_endpoint: `${ISSUER}/oauth/register`,
        end_session_endpoint: `${ISSUER}/oauth/end_session`,
        // Deliberately WIDER than bkey's real issuers (which advertise
        // ["EdDSA"] only): the SDK's accepted-algorithm set is a static
        // allowlist and must not be widened by whatever the doc claims.
        id_token_signing_alg_values_supported: ['EdDSA', 'RS256'],
      });
    }
    if (url.pathname === '/oauth/jwks') return send(200, { keys: [edJwk, rsaJwk] });
    if (url.pathname === '/oauth/register' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body) as Record<string, unknown>;
      return send(201, {
        client_id: MANAGED_CLIENT_ID,
        client_secret: 'bkey_secret_shhh',
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_secret_expires_at: 0,
        registration_access_token: 'bkey_rat_once',
        registration_client_uri: REGISTRATION_CLIENT_URI,
        client_name: parsed.client_name,
        redirect_uris: parsed.redirect_uris,
        post_logout_redirect_uris: parsed.post_logout_redirect_uris ?? [],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: parsed.token_endpoint_auth_method,
        id_token_signed_response_alg: 'EdDSA',
        scope: 'openid',
      });
    }
    if (url.pathname.startsWith(REGISTRATION_CLIENT_URI.replace(ISSUER, ''))) {
      let body: Record<string, unknown> | undefined;
      if (req.method === 'PATCH' || req.method === 'POST') {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
      }
      opState.managementRequests.push({
        method: req.method ?? '',
        path: url.pathname,
        authorization: req.headers.authorization,
        body,
      });
      if (opState.rejectManagement) {
        return send(401, {
          error: 'unauthenticated',
          error_description: 'invalid registration access token',
        });
      }
      if (url.pathname === `${REGISTRATION_CLIENT_URI.replace(ISSUER, '')}/rotate-secret`) {
        return send(200, {
          client_id: MANAGED_CLIENT_ID,
          client_secret: 'bkey_secret_rotated',
          client_secret_expires_at: 0,
          old_secret_expires_at:
            body?.grace_hours === 0 ? null : '2026-08-22T12:00:00.000Z',
        });
      }
      if (req.method === 'DELETE') {
        res.statusCode = 204;
        return res.end();
      }
      return send(200, {
        client_id: MANAGED_CLIENT_ID,
        client_id_issued_at: 1_776_000_000,
        registration_client_uri: REGISTRATION_CLIENT_URI,
        client_name: body?.client_name ?? 'Test RP',
        redirect_uris: body?.redirect_uris ?? [REDIRECT],
        post_logout_redirect_uris: body?.post_logout_redirect_uris ?? [],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
        id_token_signed_response_alg: body?.id_token_signed_response_alg ?? 'EdDSA',
        scope: 'openid',
      });
    }
    if (url.pathname === '/oauth/token' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const params = new URLSearchParams(body);
      opState.lastCodeVerifier = params.get('code_verifier');
      let signer = new SignJWT({
        nonce: opState.tamperNonce ? 'evil-nonce' : opState.nonce,
        token_type: 'id',
      })
        .setProtectedHeader(
          opState.signRs256
            ? { alg: 'RS256', kid: rsaJwk.kid! }
            : { alg: 'EdDSA', kid: edJwk.kid! },
        )
        .setSubject('did:bkey:zLoginSdkUser')
        .setIssuer(ISSUER)
        .setAudience(opState.aud);
      // A non-conformant OP that omits exp/iat — the SDK must reject it
      // rather than treat the id_token as never-expiring.
      if (!opState.omitExp) {
        signer = signer.setIssuedAt().setExpirationTime('5m');
      }
      const idToken = await signer.sign(opState.signRs256 ? rsaPrivate : edPrivate);
      return send(200, {
        access_token: 'at_x',
        refresh_token: 'rt_x',
        token_type: 'Bearer',
        expires_in: 300,
        id_token: idToken,
        scope: 'openid',
      });
    }
    if (url.pathname === '/oauth/revoke' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      opState.lastRevocation = new URLSearchParams(body);
      if (opState.hangRevocation) return;
      if (opState.rejectRevocation) {
        return send(401, {
          error: 'invalid_client',
          error_description: 'client authentication failed',
        });
      }
      res.statusCode = 200;
      return res.end();
    }
    send(404, { error: 'not_found' });
  });
  await new Promise<void>((r) => server.listen(PORT, r));
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

function loginFor(overrides: Partial<Parameters<typeof createBkeyLogin>[0]> = {}) {
  return createBkeyLogin({
    issuer: ISSUER,
    clientId: CLIENT_ID,
    clientSecret: 'secret',
    redirectUri: REDIRECT,
    ...overrides,
  });
}

describe('registerClient (RFC 7591)', () => {
  it('returns the one-time management values with the client credentials', async () => {
    const reg = await registerClient({
      issuer: ISSUER,
      redirectUris: [REDIRECT],
      clientName: 'Test RP',
    });
    expect(reg.clientId).toBe(MANAGED_CLIENT_ID);
    expect(reg.clientSecret).toBe('bkey_secret_shhh');
    expect(reg.clientSecretExpiresAt).toBe(0);
    expect(reg.registrationClientUri).toBe(REGISTRATION_CLIENT_URI);
    expect(reg.registrationAccessToken).toBe('bkey_rat_once');
    expect(reg.clientName).toBe('Test RP');
    expect(reg.grantTypes).toEqual(['authorization_code']);
    expect(reg.responseTypes).toEqual(['code']);
    expect(reg.tokenEndpointAuthMethod).toBe('client_secret_post');
    expect(reg.idTokenSignedResponseAlg).toBe('EdDSA');
    expect(reg.scope).toBe('openid');
  });
});

describe('dynamic client lifecycle (RFC 7592 + BKey extensions)', () => {
  const management = {
    issuer: ISSUER,
    registrationClientUri: REGISTRATION_CLIENT_URI,
    managementAccessToken: 'bkey_rat_once',
  };

  it('reads client metadata with the separate management token', async () => {
    const client = await getRegisteredClient(management);

    expect(client.clientId).toBe(MANAGED_CLIENT_ID);
    expect(client.clientName).toBe('Test RP');
    expect(opState.managementRequests.at(-1)).toMatchObject({
      method: 'GET',
      path: `/oauth/register/${MANAGED_CLIENT_ID}`,
      authorization: 'Bearer bkey_rat_once',
    });
  });

  it('updates only the supplied editable metadata', async () => {
    const updated = await updateRegisteredClient({
      ...management,
      clientName: 'Renamed RP',
      redirectUris: ['https://rp.example/new-callback'],
      postLogoutRedirectUris: ['https://rp.example/signed-out'],
      idTokenSignedResponseAlg: 'EdDSA',
    });

    expect(updated.clientName).toBe('Renamed RP');
    expect(updated.redirectUris).toEqual(['https://rp.example/new-callback']);
    expect(opState.managementRequests.at(-1)).toMatchObject({
      method: 'PATCH',
      authorization: 'Bearer bkey_rat_once',
      body: {
        client_name: 'Renamed RP',
        redirect_uris: ['https://rp.example/new-callback'],
        post_logout_redirect_uris: ['https://rp.example/signed-out'],
        id_token_signed_response_alg: 'EdDSA',
      },
    });
  });

  it('rotates the secret with an explicit immediate-revocation grace period', async () => {
    const rotated = await rotateClientSecret({ ...management, graceHours: 0 });

    expect(rotated).toEqual({
      clientId: MANAGED_CLIENT_ID,
      clientSecret: 'bkey_secret_rotated',
      clientSecretExpiresAt: 0,
      oldSecretExpiresAt: null,
    });
    expect(opState.managementRequests.at(-1)).toMatchObject({
      method: 'POST',
      path: `/oauth/register/${MANAGED_CLIENT_ID}/rotate-secret`,
      authorization: 'Bearer bkey_rat_once',
      body: { grace_hours: 0 },
    });
  });

  it('deletes the registration with the management credential', async () => {
    await expect(deleteRegisteredClient(management)).resolves.toBeUndefined();
    expect(opState.managementRequests.at(-1)).toMatchObject({
      method: 'DELETE',
      path: `/oauth/register/${MANAGED_CLIENT_ID}`,
      authorization: 'Bearer bkey_rat_once',
    });
  });

  it('claims an anonymous client with both required credentials', async () => {
    const claimed = await claimRegisteredClient({
      issuer: ISSUER,
      registrationClientUri: REGISTRATION_CLIENT_URI,
      ownerAccessToken: 'owner_user_token',
      registrationAccessToken: 'bkey_rat_once',
    });

    expect(claimed.clientId).toBe(MANAGED_CLIENT_ID);
    expect(opState.managementRequests.at(-1)).toMatchObject({
      method: 'POST',
      path: `/oauth/register/${MANAGED_CLIENT_ID}/claim`,
      authorization: 'Bearer owner_user_token',
      body: { registration_access_token: 'bkey_rat_once' },
    });
  });

  it('preserves the backend error code and description', async () => {
    opState.rejectManagement = true;
    try {
      await expect(getRegisteredClient(management)).rejects.toMatchObject({
        name: 'BkeyLoginError',
        code: 'unauthenticated',
        message: 'invalid registration access token',
      });
    } finally {
      opState.rejectManagement = false;
    }
  });

  it('rejects a management URI outside the configured issuer origin', async () => {
    await expect(
      getRegisteredClient({
        ...management,
        registrationClientUri: `https://evil.example/oauth/register/${MANAGED_CLIENT_ID}`,
      }),
    ).rejects.toMatchObject({ code: 'discovery_endpoint_off_origin' });
  });
});

describe('authorizationUrl', () => {
  it('builds a code+PKCE(S256)+nonce+state request', async () => {
    const auth = await loginFor().authorizationUrl();
    const url = new URL(auth.url);
    expect(url.pathname).toBe('/oauth/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('scope')).toBe('openid');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    // challenge must be the S256 of the returned verifier
    const expectedChallenge = createHash('sha256')
      .update(auth.codeVerifier, 'ascii')
      .digest('base64url');
    expect(url.searchParams.get('code_challenge')).toBe(expectedChallenge);
    expect(url.searchParams.get('state')).toBe(auth.state);
    expect(url.searchParams.get('nonce')).toBe(auth.nonce);
  });

  it('rejects a non-HTTPS revocation endpoint outside loopback', async () => {
    const issuer = 'https://id.example.com';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          issuer,
          authorization_endpoint: `${issuer}/oauth/authorize`,
          token_endpoint: `${issuer}/oauth/token`,
          revocation_endpoint: 'http://id.example.com/oauth/revoke',
          jwks_uri: `${issuer}/oauth/jwks`,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    try {
      await expect(
        createBkeyLogin({
          issuer,
          clientId: CLIENT_ID,
          clientSecret: 'secret',
          redirectUri: REDIRECT,
        }).authorizationUrl(),
      ).rejects.toMatchObject({ code: 'discovery_endpoint_insecure' });
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('handleCallback', () => {
  it('exchanges the code and returns the verified user', async () => {
    const bkey = loginFor();
    const auth = await bkey.authorizationUrl();
    opState.nonce = auth.nonce;
    opState.tamperNonce = false;
    opState.aud = CLIENT_ID;
    const cb = `${REDIRECT}?code=authcode_1&state=${encodeURIComponent(auth.state)}`;
    const user = await bkey.handleCallback(cb, auth);
    expect(user.sub).toBe('did:bkey:zLoginSdkUser');
    expect(user.idToken.split('.')).toHaveLength(3);
    expect(user.accessToken).toBe('at_x');
    // The SDK sent the PKCE verifier it minted.
    expect(opState.lastCodeVerifier).toBe(auth.codeVerifier);
  });

  it('rejects a state mismatch (CSRF)', async () => {
    const bkey = loginFor();
    const auth = await bkey.authorizationUrl();
    const cb = `${REDIRECT}?code=authcode_2&state=WRONG`;
    await expect(bkey.handleCallback(cb, auth)).rejects.toMatchObject({
      code: 'state_mismatch',
    });
  });

  it('rejects a nonce mismatch (replay)', async () => {
    const bkey = loginFor();
    const auth = await bkey.authorizationUrl();
    opState.nonce = auth.nonce;
    opState.tamperNonce = true;
    const cb = `${REDIRECT}?code=authcode_3&state=${encodeURIComponent(auth.state)}`;
    await expect(bkey.handleCallback(cb, auth)).rejects.toMatchObject({
      code: 'nonce_mismatch',
    });
    opState.tamperNonce = false;
  });

  it('rejects an id_token minted for a different client (audience)', async () => {
    const bkey = loginFor();
    const auth = await bkey.authorizationUrl();
    opState.nonce = auth.nonce;
    opState.aud = 'bkey_client_someone_else';
    const cb = `${REDIRECT}?code=authcode_4&state=${encodeURIComponent(auth.state)}`;
    await expect(bkey.handleCallback(cb, auth)).rejects.toThrow();
    opState.aud = CLIENT_ID;
  });

  it('rejects an id_token with no exp claim (must not accept a never-expiring token)', async () => {
    const bkey = loginFor();
    const auth = await bkey.authorizationUrl();
    opState.nonce = auth.nonce;
    opState.omitExp = true;
    const cb = `${REDIRECT}?code=authcode_noexp&state=${encodeURIComponent(auth.state)}`;
    await expect(bkey.handleCallback(cb, auth)).rejects.toThrow();
    opState.omitExp = false;
  });

  it('rejects an RS256 id_token even when discovery advertises RS256 (bkey#53)', async () => {
    // The signature is genuine and the key IS in the JWKS — only the algorithm
    // is outside the allowlist. bkey issuers sign EdDSA and publish a single
    // Ed25519 key, so anything else is either a tampered doc or an OP that is
    // not bkey; neither is a token this SDK should accept.
    const bkey = loginFor();
    const auth = await bkey.authorizationUrl();
    opState.nonce = auth.nonce;
    opState.signRs256 = true;
    try {
      const cb = `${REDIRECT}?code=authcode_rs256&state=${encodeURIComponent(auth.state)}`;
      await expect(bkey.handleCallback(cb, auth)).rejects.toThrow();
    } finally {
      opState.signRs256 = false;
    }
  });

  it('surfaces OP errors from the callback', async () => {
    const bkey = loginFor();
    const auth = await bkey.authorizationUrl();
    const cb = `${REDIRECT}?error=access_denied&error_description=user+declined`;
    await expect(bkey.handleCallback(cb, auth)).rejects.toMatchObject({
      code: 'access_denied',
    });
  });

  it('rejects an off-origin token_endpoint from the discovery doc (no code/secret exfil)', async () => {
    // fetchDiscovery pins EVERY endpoint up front, so a tampered token_endpoint
    // is caught at the first discovery fetch — before any code/secret is POSTed.
    opState.offOriginToken = true;
    try {
      const bkey = loginFor();
      await expect(bkey.authorizationUrl()).rejects.toMatchObject({
        code: 'discovery_endpoint_off_origin',
      });
    } finally {
      opState.offOriginToken = false;
    }
  });
});

describe('endSessionUrl', () => {
  it('builds the RP-initiated logout URL', async () => {
    const url = new URL(
      await loginFor().endSessionUrl({
        idToken: 'a.b.c',
        postLogoutRedirectUri: 'https://rp.example/bye',
        state: 's1',
      }),
    );
    expect(url.pathname).toBe('/oauth/end_session');
    expect(url.searchParams.get('id_token_hint')).toBe('a.b.c');
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe('https://rp.example/bye');
    expect(url.searchParams.get('state')).toBe('s1');
  });
});

describe('token revocation (RFC 7009)', () => {
  it('revokes a refresh token with confidential-client authentication', async () => {
    await loginFor().revokeRefreshToken('rt_x');

    expect(opState.lastRevocation?.get('token')).toBe('rt_x');
    expect(opState.lastRevocation?.get('token_type_hint')).toBe('refresh_token');
    expect(opState.lastRevocation?.get('client_id')).toBe(CLIENT_ID);
    expect(opState.lastRevocation?.get('client_secret')).toBe('secret');
  });

  it('supports public clients and reports OAuth errors', async () => {
    opState.rejectRevocation = true;
    try {
      await expect(
        loginFor({ clientSecret: undefined }).revokeAccessToken('at_x'),
      ).rejects.toMatchObject({ code: 'invalid_client' });
      expect(opState.lastRevocation?.get('client_id')).toBe(CLIENT_ID);
      expect(opState.lastRevocation?.has('client_secret')).toBe(false);
      expect(opState.lastRevocation?.get('token_type_hint')).toBe('access_token');
    } finally {
      opState.rejectRevocation = false;
    }
  });

  it('accepts an AbortSignal for a stalled revocation request', async () => {
    opState.hangRevocation = true;
    try {
      await expect(
        loginFor().revokeAccessToken('at_x', { signal: AbortSignal.timeout(25) }),
      ).rejects.toThrow();
    } finally {
      opState.hangRevocation = false;
    }
  });

  it('applies an already-aborted caller signal before fresh-client discovery', async () => {
    opState.hangDiscovery = true;
    const controller = new AbortController();
    controller.abort();
    try {
      await expect(
        loginFor().revokeAccessToken('at_x', { signal: controller.signal }),
      ).rejects.toThrow();
    } finally {
      opState.hangDiscovery = false;
    }
  });

  it('keeps the default deadline when the caller signal does not fire', async () => {
    opState.hangDiscovery = true;
    const shortDeadline = AbortSignal.timeout(25);
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(shortDeadline);
    const caller = new AbortController();
    try {
      await expect(
        loginFor().revokeAccessToken('at_x', { signal: caller.signal }),
      ).rejects.toThrow();
      expect(timeoutSpy).toHaveBeenCalledWith(5_000);
    } finally {
      timeoutSpy.mockRestore();
      opState.hangDiscovery = false;
    }
  });
});

describe('BkeyProvider (Auth.js preset)', () => {
  it('emits a pkce+nonce OIDC provider config with sub-only profile', () => {
    const p = BkeyProvider({ clientId: 'abc', clientSecret: 'xyz' });
    expect(p.type).toBe('oidc');
    // The default MUST be the self-consistent issuer host. `auth.bkey.id`
    // serves discovery but declares `issuer: https://id.bkey.id`, so it fails
    // the OIDC Discovery §4.3 issuer-equality check in every conformant client.
    expect(p.issuer).toBe('https://id.bkey.id');
    expect(p.issuer).toBe(BKEY_DEFAULT_ISSUER);
    // state (CSRF) alongside pkce + nonce.
    expect(p.checks).toEqual(['pkce', 'nonce', 'state']);
    expect(p.client.id_token_signed_response_alg).toBe('EdDSA');
    // Confidential client (secret present) → client_secret_post (the bkey token
    // endpoint only accepts that); else Auth.js would default to Basic and fail.
    expect(p.client.token_endpoint_auth_method).toBe('client_secret_post');
    expect(p.profile({ sub: 'did:bkey:zU' })).toEqual({ id: 'did:bkey:zU' });
    expect(BkeyProvider({ clientId: 'a', issuer: 'https://staging-api.bkey.id' }).issuer).toBe(
      'https://staging-api.bkey.id',
    );
  });

  it("a public (no-secret, PKCE-only) client uses token_endpoint_auth_method 'none'", () => {
    const p = BkeyProvider({ clientId: 'public-spa' });
    expect(p.clientSecret).toBeUndefined();
    // Must NOT claim client_secret_post when there is no secret to post.
    expect(p.client.token_endpoint_auth_method).toBe('none');
    expect(p.checks).toEqual(['pkce', 'nonce', 'state']);
  });
});

describe('error taxonomy', () => {
  it('BkeyLoginError carries a stable code', () => {
    const e = new BkeyLoginError('discovery_failed', 'nope');
    expect(e.code).toBe('discovery_failed');
    expect(e.name).toBe('BkeyLoginError');
  });
});
