import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createHash } from 'node:crypto';
import {
  SignJWT,
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  type JWK,
} from 'jose';
import { createBkeyLogin, registerClient } from './client.js';
import { BkeyLoginError } from './types.js';
import { BkeyProvider } from './authjs.js';

/**
 * Full-flow tests against an in-process mock bkey OP: discovery + JWKS +
 * RFC 7591 registration + token endpoint minting REAL EdDSA id_tokens. The
 * mock echoes the nonce it is given and records the PKCE verifier hash so
 * the tests can assert the SDK sent a correct S256 challenge.
 */

const PORT = 18583;
const ISSUER = `http://localhost:${PORT}`;
const CLIENT_ID = 'bkey_client_login_sdk';
const REDIRECT = 'https://rp.example/auth/callback/bkey';

let server: http.Server;
let edPrivate: CryptoKey;
let edJwk: JWK;
const opState: {
  nonce: string | null;
  lastCodeVerifier: string | null;
  lastCodeChallenge: string | null;
  tamperNonce: boolean;
  aud: string;
} = { nonce: null, lastCodeVerifier: null, lastCodeChallenge: null, tamperNonce: false, aud: CLIENT_ID };

beforeAll(async () => {
  // jose v5 names the keygen alg 'EdDSA' (v6 renamed it 'Ed25519').
  const kp = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  edPrivate = kp.privateKey as CryptoKey;
  edJwk = await exportJWK(kp.publicKey);
  edJwk.kid = await calculateJwkThumbprint(edJwk, 'sha256');
  edJwk.use = 'sig';
  edJwk.alg = 'EdDSA';

  server = http.createServer(async (req, res) => {
    const send = (status: number, obj: unknown) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(obj));
    };
    const url = new URL(req.url!, ISSUER);
    if (url.pathname === '/.well-known/openid-configuration') {
      return send(200, {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/oauth/authorize`,
        token_endpoint: `${ISSUER}/oauth/token`,
        jwks_uri: `${ISSUER}/oauth/jwks`,
        registration_endpoint: `${ISSUER}/oauth/register`,
        end_session_endpoint: `${ISSUER}/oauth/end_session`,
        id_token_signing_alg_values_supported: ['EdDSA', 'RS256'],
      });
    }
    if (url.pathname === '/oauth/jwks') return send(200, { keys: [edJwk] });
    if (url.pathname === '/oauth/register' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body) as Record<string, unknown>;
      return send(201, {
        client_id: 'bkey_client_fresh123',
        client_secret: 'bkey_secret_shhh',
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: parsed.redirect_uris,
        token_endpoint_auth_method: parsed.token_endpoint_auth_method,
        id_token_signed_response_alg: 'EdDSA',
        scope: 'openid',
      });
    }
    if (url.pathname === '/oauth/token' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const params = new URLSearchParams(body);
      opState.lastCodeVerifier = params.get('code_verifier');
      const idToken = await new SignJWT({
        nonce: opState.tamperNonce ? 'evil-nonce' : opState.nonce,
        token_type: 'id',
      })
        .setProtectedHeader({ alg: 'EdDSA', kid: edJwk.kid! })
        .setSubject('did:bkey:zLoginSdkUser')
        .setIssuer(ISSUER)
        .setAudience(opState.aud)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(edPrivate);
      return send(200, {
        access_token: 'at_x',
        refresh_token: 'rt_x',
        token_type: 'Bearer',
        expires_in: 300,
        id_token: idToken,
        scope: 'openid',
      });
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
  it('registers and returns client_id + secret', async () => {
    const reg = await registerClient({
      issuer: ISSUER,
      redirectUris: [REDIRECT],
      clientName: 'Test RP',
    });
    expect(reg.clientId).toBe('bkey_client_fresh123');
    expect(reg.clientSecret).toBe('bkey_secret_shhh');
    expect(reg.idTokenSignedResponseAlg).toBe('EdDSA');
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

  it('surfaces OP errors from the callback', async () => {
    const bkey = loginFor();
    const auth = await bkey.authorizationUrl();
    const cb = `${REDIRECT}?error=access_denied&error_description=user+declined`;
    await expect(bkey.handleCallback(cb, auth)).rejects.toMatchObject({
      code: 'access_denied',
    });
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

describe('BkeyProvider (Auth.js preset)', () => {
  it('emits a pkce+nonce OIDC provider config with sub-only profile', () => {
    const p = BkeyProvider({ clientId: 'abc', clientSecret: 'xyz' });
    expect(p.type).toBe('oidc');
    expect(p.issuer).toBe('https://auth.bkey.id');
    expect(p.checks).toEqual(['pkce', 'nonce']);
    expect(p.client.id_token_signed_response_alg).toBe('EdDSA');
    expect(p.profile({ sub: 'did:bkey:zU' })).toEqual({ id: 'did:bkey:zU' });
    expect(BkeyProvider({ clientId: 'a', issuer: 'https://staging-api.bkey.id' }).issuer).toBe(
      'https://staging-api.bkey.id',
    );
  });
});

describe('error taxonomy', () => {
  it('BkeyLoginError carries a stable code', () => {
    const e = new BkeyLoginError('discovery_failed', 'nope');
    expect(e.code).toBe('discovery_failed');
    expect(e.name).toBe('BkeyLoginError');
  });
});
