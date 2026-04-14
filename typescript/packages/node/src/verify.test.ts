// copyright © 2025-2026 bkey inc. all rights reserved.

import { SignJWT, generateKeyPair, exportJWK, type KeyLike } from 'jose';
import { describe, it, expect, beforeAll } from 'vitest';

import { BKeyAuthError, extractBearerToken, verifyToken } from './index.js';

// ─── Test harness: generate a keypair, mint real JWTs, pass JWKS inline ─

interface TestKeys {
  privateKey: KeyLike;
  publicKey: KeyLike;
  publicJwk: Record<string, unknown>;
}

async function makeKeys(): Promise<TestKeys> {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', {
    crv: 'Ed25519',
    extractable: true,
  });
  const publicJwk = (await exportJWK(publicKey)) as unknown as Record<string, unknown>;
  publicJwk.kid = 'test-key-1';
  publicJwk.alg = 'EdDSA';
  publicJwk.use = 'sig';
  return { privateKey, publicKey, publicJwk };
}

function jwksFor(keys: TestKeys): { keys: Array<Record<string, unknown>> } {
  return { keys: [keys.publicJwk] };
}

interface SignOpts {
  sub?: string;
  iss?: string;
  scope?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  clientId?: string;
  kid?: string;
  alg?: string;
}

async function signToken(keys: TestKeys, opts: SignOpts = {}): Promise<string> {
  const payload: Record<string, unknown> = {
    sub: opts.sub ?? 'did:bkey:zAlice',
    scope: opts.scope ?? '',
  };
  if (opts.clientId) payload.client_id = opts.clientId;

  const jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: opts.alg ?? 'EdDSA', kid: opts.kid ?? 'test-key-1' })
    .setIssuer(opts.iss ?? 'https://api.bkey.id')
    .setIssuedAt();

  if (opts.aud) jwt.setAudience(opts.aud);
  if (opts.exp !== undefined) jwt.setExpirationTime(opts.exp);
  else jwt.setExpirationTime('1h');
  if (opts.nbf !== undefined) jwt.setNotBefore(opts.nbf);

  return await jwt.sign(keys.privateKey);
}

describe('verifyToken', () => {
  let keys: TestKeys;
  const issuer = 'https://api.bkey.id';

  beforeAll(async () => {
    keys = await makeKeys();
  });

  describe('happy path', () => {
    it('verifies a valid token and returns claims', async () => {
      const token = await signToken(keys, { iss: issuer, sub: 'did:bkey:zAlice' });

      const claims = await verifyToken(token, { issuer, jwks: jwksFor(keys), scope: [] });

      expect(claims.sub).toBe('did:bkey:zAlice');
      expect(claims.iss).toBe(issuer);
      expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it('derives scopes array from scope string', async () => {
      const token = await signToken(keys, {
        iss: issuer,
        scope: 'approve:payment approve:action openid',
      });

      const claims = await verifyToken(token, { issuer, jwks: jwksFor(keys), scope: [] });
      expect(claims.scope).toBe('approve:payment approve:action openid');
      expect(claims.scopes).toEqual(['approve:payment', 'approve:action', 'openid']);
    });

    it('empty scope yields empty scopes array', async () => {
      const token = await signToken(keys, { iss: issuer });

      const claims = await verifyToken(token, { issuer, jwks: jwksFor(keys), scope: [] });
      expect(claims.scopes).toEqual([]);
    });

    it('passes with required single scope', async () => {
      const token = await signToken(keys, { iss: issuer, scope: 'approve:payment' });

      const claims = await verifyToken(token, {
        issuer,
        jwks: jwksFor(keys),
        scope: 'approve:payment',
      });
      expect(claims.scopes).toContain('approve:payment');
    });

    it('passes when token has ALL required scopes', async () => {
      const token = await signToken(keys, {
        iss: issuer,
        scope: 'approve:payment vault:read extra:scope',
      });

      const claims = await verifyToken(token, {
        issuer,
        jwks: jwksFor(keys),
        scope: ['approve:payment', 'vault:read'],
      });
      expect(claims.scopes).toContain('approve:payment');
    });

    it('exposes client_id for client_credentials tokens', async () => {
      const token = await signToken(keys, {
        iss: issuer,
        clientId: 'bkey_client_abc123',
      });

      const claims = await verifyToken(token, { issuer, jwks: jwksFor(keys), scope: [] });
      expect(claims.client_id).toBe('bkey_client_abc123');
    });
  });

  describe('scope enforcement', () => {
    it('rejects when token is missing the required scope', async () => {
      const token = await signToken(keys, { iss: issuer, scope: 'approve:action' });

      await expect(
        verifyToken(token, { issuer, jwks: jwksFor(keys), scope: 'approve:payment' }),
      ).rejects.toMatchObject({ code: 'insufficient_scope', status: 403 });
    });

    it('rejects when token is missing one of several required scopes', async () => {
      const token = await signToken(keys, { iss: issuer, scope: 'approve:payment' });

      await expect(
        verifyToken(token, {
          issuer,
          jwks: jwksFor(keys),
          scope: ['approve:payment', 'vault:read'],
        }),
      ).rejects.toMatchObject({ code: 'insufficient_scope' });
    });

    it('rejects when empty scope is present but required scopes are not', async () => {
      const token = await signToken(keys, { iss: issuer, scope: '' });

      await expect(
        verifyToken(token, { issuer, jwks: jwksFor(keys), scope: 'approve:payment' }),
      ).rejects.toMatchObject({ code: 'insufficient_scope' });
    });
  });

  describe('issuer validation', () => {
    it('rejects token with mismatched issuer', async () => {
      const token = await signToken(keys, { iss: 'https://attacker.com' });

      await expect(
        verifyToken(token, { issuer, jwks: jwksFor(keys), scope: [] }),
      ).rejects.toMatchObject({ code: 'invalid_issuer' });
    });
  });

  describe('expiry validation', () => {
    it('rejects expired token', async () => {
      const token = await signToken(keys, {
        iss: issuer,
        exp: Math.floor(Date.now() / 1000) - 3600,
      });

      await expect(
        verifyToken(token, { issuer, jwks: jwksFor(keys), scope: [], clockTolerance: 0 }),
      ).rejects.toMatchObject({ code: 'expired_token' });
    });

    it('allows clock skew within tolerance', async () => {
      const token = await signToken(keys, {
        iss: issuer,
        exp: Math.floor(Date.now() / 1000) - 5,
      });

      const claims = await verifyToken(token, {
        issuer,
        jwks: jwksFor(keys),
        scope: [],
        clockTolerance: 30,
      });
      expect(claims.iss).toBe(issuer);
    });
  });

  describe('audience validation', () => {
    it('rejects token with wrong audience when audience is required', async () => {
      const token = await signToken(keys, { iss: issuer, aud: 'other-app' });

      await expect(
        verifyToken(token, { issuer, jwks: jwksFor(keys), audience: 'my-app' }),
      ).rejects.toMatchObject({ code: 'invalid_audience' });
    });

    it('accepts token with matching audience', async () => {
      const token = await signToken(keys, { iss: issuer, aud: 'my-app' });

      const claims = await verifyToken(token, {
        issuer,
        jwks: jwksFor(keys),
        audience: 'my-app',
      });
      expect(claims.aud).toBe('my-app');
    });

    it('skips audience check when not configured', async () => {
      const token = await signToken(keys, { iss: issuer, aud: 'anything' });

      const claims = await verifyToken(token, { issuer, jwks: jwksFor(keys), scope: [] });
      expect(claims.aud).toBe('anything');
    });
  });

  describe('signature validation', () => {
    it('rejects token signed by a different key', async () => {
      const keys2 = await makeKeys();
      const attackerToken = await signToken(keys2, { iss: issuer });

      await expect(
        verifyToken(attackerToken, { issuer, jwks: jwksFor(keys), scope: [] }),
      ).rejects.toMatchObject({ code: 'invalid_signature' });
    });

    it('rejects tampered payload', async () => {
      const token = await signToken(keys, { iss: issuer, sub: 'did:bkey:zAlice' });

      const parts = token.split('.');
      const tampered = [parts[0], 'eyJzdWIiOiJhdHRhY2tlciJ9', parts[2]].join('.');

      await expect(
        verifyToken(tampered, { issuer, jwks: jwksFor(keys), scope: [] }),
      ).rejects.toMatchObject({ code: 'invalid_signature' });
    });

    it('rejects unsigned token (alg=none, empty signature segment)', async () => {
      // Construct a JWT-looking string with alg=none and empty signature.
      // Our JWT_SHAPE regex requires all three segments to be non-empty,
      // so this is rejected at the shape check before hitting jose.
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString(
        'base64url',
      );
      const payload = Buffer.from(
        JSON.stringify({ sub: 'attacker', iss: issuer, exp: Math.floor(Date.now() / 1000) + 3600 }),
      ).toString('base64url');
      const unsigned = `${header}.${payload}.`;

      await expect(
        verifyToken(unsigned, { issuer, jwks: jwksFor(keys), scope: [] }),
      ).rejects.toMatchObject({ code: 'malformed_token' });
    });

    it('rejects alg=none even with a garbage signature segment', async () => {
      // Crafts a "token" with alg=none in the header but a non-empty
      // signature segment so it passes JWT_SHAPE. jose must still reject
      // this because the algorithms list is pinned to EdDSA.
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString(
        'base64url',
      );
      const payload = Buffer.from(
        JSON.stringify({
          sub: 'attacker',
          iss: issuer,
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      ).toString('base64url');
      const fakeSig = 'AAAA'; // base64url-valid
      const bogus = `${header}.${payload}.${fakeSig}`;

      await expect(
        verifyToken(bogus, { issuer, jwks: jwksFor(keys), scope: [] }),
      ).rejects.toMatchObject({ code: 'invalid_signature' });
    });

    it('rejects HS256 token signed with public key as secret (algorithm confusion)', async () => {
      // Export the public key as a symmetric secret — this is the classic
      // algorithm confusion attack. Our code pins algorithms: ['EdDSA'] so
      // this must fail.
      const jwk = keys.publicJwk as { x?: string };
      const secretBytes = Buffer.from(jwk.x ?? '', 'base64url');
      const attackerToken = await new SignJWT({ sub: 'attacker', scope: '' })
        .setProtectedHeader({ alg: 'HS256', kid: 'test-key-1' })
        .setIssuer(issuer)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(new Uint8Array(secretBytes));

      await expect(
        verifyToken(attackerToken, { issuer, jwks: jwksFor(keys), scope: [] }),
      ).rejects.toMatchObject({ code: 'invalid_signature' });
    });
  });

  describe('malformed input', () => {
    it('rejects empty token', async () => {
      await expect(
        verifyToken('', { issuer, jwks: jwksFor(keys), scope: [] }),
      ).rejects.toMatchObject({ code: 'malformed_token' });
    });

    it('rejects non-string token', async () => {
      await expect(
        verifyToken(null as unknown as string, { issuer, jwks: jwksFor(keys), scope: [] }),
      ).rejects.toMatchObject({ code: 'malformed_token' });
    });

    it('rejects token longer than MAX_TOKEN_LENGTH (8KB)', async () => {
      const giant = 'a'.repeat(8193);
      await expect(
        verifyToken(giant, { issuer, jwks: jwksFor(keys), scope: [] }),
      ).rejects.toMatchObject({ code: 'malformed_token' });
    });

    it('rejects token with non-JWT shape (not three segments)', async () => {
      await expect(
        verifyToken('abc', { issuer, jwks: jwksFor(keys), scope: [] }),
      ).rejects.toMatchObject({ code: 'malformed_token' });
      await expect(
        verifyToken('a.b', { issuer, jwks: jwksFor(keys), scope: [] }),
      ).rejects.toMatchObject({ code: 'malformed_token' });
      await expect(
        verifyToken('a.b.c.d', { issuer, jwks: jwksFor(keys), scope: [] }),
      ).rejects.toMatchObject({ code: 'malformed_token' });
    });

    it('rejects token with whitespace characters', async () => {
      await expect(
        verifyToken('abc.def.ghi\n', { issuer, jwks: jwksFor(keys), scope: [] }),
      ).rejects.toMatchObject({ code: 'malformed_token' });
    });
  });

  describe('claim type validation (defends against malicious issuer)', () => {
    it('rejects token with non-string sub', async () => {
      // Sign a token whose sub is a number — jose won't object to this,
      // so our post-verify type guard must catch it.
      const token = await new SignJWT({ sub: 12345 as unknown as string, scope: '' })
        .setProtectedHeader({ alg: 'EdDSA', kid: 'test-key-1' })
        .setIssuer(issuer)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(keys.privateKey);

      await expect(
        verifyToken(token, { issuer, jwks: jwksFor(keys), scope: [] }),
      ).rejects.toMatchObject({ code: 'invalid_signature' });
    });

    it('rejects token with missing sub', async () => {
      const token = await new SignJWT({ scope: 'approve:payment' })
        .setProtectedHeader({ alg: 'EdDSA', kid: 'test-key-1' })
        .setIssuer(issuer)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(keys.privateKey);

      await expect(
        verifyToken(token, { issuer, jwks: jwksFor(keys), scope: [] }),
      ).rejects.toMatchObject({ code: 'invalid_signature' });
    });

    it('rejects token where scope is an array (type confusion)', async () => {
      // A malicious issuer could try to smuggle scopes as an array to
      // bypass the split-on-whitespace check. Our verify throws instead
      // of silently coercing to the empty string.
      const token = await new SignJWT({
        sub: 'did:bkey:zAlice',
        scope: ['admin', 'write'] as unknown as string,
      })
        .setProtectedHeader({ alg: 'EdDSA', kid: 'test-key-1' })
        .setIssuer(issuer)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(keys.privateKey);

      await expect(
        verifyToken(token, { issuer, jwks: jwksFor(keys), scope: [] }),
      ).rejects.toMatchObject({ code: 'invalid_signature' });
    });

    it('thrown error.cause does not carry jose payload/claim fields', async () => {
      // Jose errors like JWTClaimValidationFailed have a `.payload` property
      // that contains the decoded token. Application loggers that walk the
      // cause chain would serialize it. Our sanitizeCause strips this.
      // Use an audience mismatch (routes through jose's validator which
      // attaches payload/claim to the thrown error).
      const token = await signToken(keys, { iss: issuer, aud: 'wrong-audience' });
      try {
        await verifyToken(token, {
          issuer,
          jwks: jwksFor(keys),
          audience: 'my-app',
        });
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(BKeyAuthError);
        expect((err as BKeyAuthError).code).toBe('invalid_audience');
        const cause = (err as BKeyAuthError).cause as unknown;
        // Cause exists (for ops debugging) but must NOT carry payload.
        expect(cause).toBeDefined();
        expect((cause as Record<string, unknown>)?.payload).toBeUndefined();
        expect((cause as Record<string, unknown>)?.claim).toBeUndefined();
      }
    });

    it('produces claims object with null prototype (defense-in-depth vs __proto__)', async () => {
      // Even a well-behaved token must produce a claims object with a null
      // prototype so that downstream code that treats the claims as a plain
      // dictionary is not vulnerable to prototype-based shenanigans.
      const token = await signToken(keys, { iss: issuer });

      const claims = await verifyToken(token, { issuer, jwks: jwksFor(keys), scope: [] });
      expect(Object.getPrototypeOf(claims)).toBeNull();
    });
  });

  describe('config validation', () => {
    it('rejects empty-string required scope', async () => {
      const token = await signToken(keys, { iss: issuer, scope: 'approve:payment' });

      await expect(
        verifyToken(token, { issuer, jwks: jwksFor(keys), scope: '' }),
      ).rejects.toMatchObject({ code: 'insufficient_scope' });
    });

    it('rejects invalid jwksCacheMaxAge', async () => {
      const { createJwksFetcher } = await import('./jwks.js');
      expect(() =>
        createJwksFetcher({ issuer, jwksCacheMaxAge: Infinity }),
      ).toThrow(BKeyAuthError);
    });

    it('rejects non-https JWKS URL', async () => {
      const { createJwksFetcher } = await import('./jwks.js');
      expect(() => createJwksFetcher({ jwksUrl: 'http://evil.example/jwks' })).toThrow(
        /https:\/\//,
      );
    });

    it('allows http://localhost JWKS URL for tests', async () => {
      const { createJwksFetcher } = await import('./jwks.js');
      expect(() => createJwksFetcher({ jwksUrl: 'http://localhost:8080/jwks' })).not.toThrow();
    });

    it('issuer normalization: trailing slash is stripped', async () => {
      const token = await signToken(keys, { iss: issuer }); // issuer has no trailing slash

      // Pass issuer WITH trailing slash — should still verify, not reject.
      const claims = await verifyToken(token, {
        issuer: `${issuer}/`,
        jwks: jwksFor(keys),
        scope: [],
      });
      expect(claims.iss).toBe(issuer);
    });

    it('throws at config time when neither audience nor scope is set', async () => {
      const token = await signToken(keys, { iss: issuer });
      await expect(
        verifyToken(token, { issuer, jwks: jwksFor(keys) }),
      ).rejects.toMatchObject({ code: 'insufficient_scope' });
    });

    it('rejects inline JWKS without kty=OKP', async () => {
      const token = await signToken(keys, { iss: issuer });
      await expect(
        verifyToken(token, {
          issuer,
          scope: [],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          jwks: { keys: [{ kty: 'RSA', n: 'junk', e: 'AQAB' } as any] },
        }),
      ).rejects.toMatchObject({ code: 'jwks_fetch_failed' });
    });

    it('rejects inline JWK that contains a "d" (private key) field', async () => {
      const token = await signToken(keys, { iss: issuer });
      const badJwk = { ...(keys.publicJwk as Record<string, unknown>), d: 'private-key-bytes' };
      await expect(
        verifyToken(token, {
          issuer,
          scope: [],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          jwks: { keys: [badJwk as any] },
        }),
      ).rejects.toMatchObject({ code: 'jwks_fetch_failed' });
    });

    it('rejects control characters in issuer', async () => {
      const { createJwksFetcher } = await import('./jwks.js');
      expect(() =>
        createJwksFetcher({ issuer: 'https://api.bkey.id\u0000evil' }),
      ).toThrow(BKeyAuthError);
    });

    it('jwks_fetch_failed error does not echo the attacker-supplied jwksUrl', async () => {
      const { createJwksFetcher } = await import('./jwks.js');
      const evilUrl = '<script>alert(1)</script>';
      try {
        createJwksFetcher({ jwksUrl: evilUrl });
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(BKeyAuthError);
        const msg = (err as BKeyAuthError).message;
        // Must not echo the attacker string.
        expect(msg).not.toContain('<script>');
        expect(msg).not.toContain('alert');
      }
    });
  });
});

describe('extractBearerToken', () => {
  it('extracts Bearer token', () => {
    expect(extractBearerToken('Bearer abc123')).toBe('abc123');
  });

  it('is case-insensitive on scheme', () => {
    expect(extractBearerToken('bearer abc123')).toBe('abc123');
    expect(extractBearerToken('BEARER abc123')).toBe('abc123');
  });

  it('rejects whitespace inside or around the token', () => {
    // Stricter than RFC 6750: we reject any extra whitespace to avoid
    // smuggling attacks via joined duplicate Authorization headers and
    // confusion around trailing whitespace in header values.
    expect(() => extractBearerToken('Bearer  abc123')).toThrow(BKeyAuthError);
    expect(() => extractBearerToken('Bearer abc123 ')).toThrow(BKeyAuthError);
    expect(() => extractBearerToken('Bearer abc 123')).toThrow(BKeyAuthError);
  });

  it('rejects smuggled comma-joined tokens', () => {
    // If two Authorization headers were joined with ", " by a buggy proxy,
    // our tight regex rejects the result instead of accepting one side.
    expect(() => extractBearerToken('Bearer tokenA, Bearer tokenB')).toThrow(
      BKeyAuthError,
    );
  });

  it('throws on missing header', () => {
    expect(() => extractBearerToken(undefined)).toThrow(BKeyAuthError);
    expect(() => extractBearerToken(null)).toThrow(BKeyAuthError);
    expect(() => extractBearerToken('')).toThrow(BKeyAuthError);
  });

  it('throws on non-Bearer scheme', () => {
    expect(() => extractBearerToken('Basic user:pass')).toThrow(BKeyAuthError);
    expect(() => extractBearerToken('abc123')).toThrow(BKeyAuthError);
  });

  it('throws on Bearer with no token', () => {
    expect(() => extractBearerToken('Bearer')).toThrow(BKeyAuthError);
    expect(() => extractBearerToken('Bearer ')).toThrow(BKeyAuthError);
  });
});

describe('BKeyAuthError', () => {
  it('sets status 401 for auth failures', () => {
    expect(new BKeyAuthError('missing_token', 'x').status).toBe(401);
    expect(new BKeyAuthError('malformed_token', 'x').status).toBe(401);
    expect(new BKeyAuthError('invalid_signature', 'x').status).toBe(401);
    expect(new BKeyAuthError('expired_token', 'x').status).toBe(401);
    expect(new BKeyAuthError('invalid_issuer', 'x').status).toBe(401);
    expect(new BKeyAuthError('invalid_audience', 'x').status).toBe(401);
  });

  it('sets status 403 for insufficient_scope', () => {
    expect(new BKeyAuthError('insufficient_scope', 'x').status).toBe(403);
  });

  it('preserves code and message', () => {
    const err = new BKeyAuthError('invalid_signature', 'bad sig');
    expect(err.code).toBe('invalid_signature');
    expect(err.message).toBe('bad sig');
    expect(err.name).toBe('BKeyAuthError');
    expect(err).toBeInstanceOf(Error);
  });
});
