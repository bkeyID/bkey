# @bkey/node

Server-side helpers for verifying [BKey](https://bkey.id) JWTs — JWKS fetching, signature verification, scope enforcement, and plug-and-play middleware for Express and Fastify.

Use this on **your backend** to gate routes behind BKey biometric approval. An AI agent requests approval via CIBA, the user approves on their phone, and the agent gets a short-lived EdDSA JWT proving the user consented. `@bkey/node` verifies that token before your handler runs.

## Install

```bash
npm install @bkey/node
# or
pnpm add @bkey/node
```

## Express

```typescript
import express from 'express';
import { requireBKeyAuth } from '@bkey/node/express';

const app = express();

app.post(
  '/deploy',
  requireBKeyAuth({ scope: 'approve:deploy' }),
  (req, res) => {
    console.log(`Approved by ${req.bkeyAuth!.sub}`);
    deployToProduction();
    res.json({ ok: true });
  },
);
```

On success, verified claims are on `req.bkeyAuth`. On failure, the middleware responds with `401` (missing / invalid / expired token) or `403` (insufficient scope) using the BKey error envelope.

## Fastify

```typescript
import fastify from 'fastify';
import { bkeyAuth } from '@bkey/node/fastify';

const app = fastify();
await app.register(bkeyAuth, { issuer: 'https://api.bkey.id' });

app.post('/deploy', {
  preHandler: [app.requireBKeyAuth({ scope: 'approve:deploy' })],
}, async (req) => {
  return { approvedBy: req.bkeyAuth!.sub };
});
```

## Raw verify API

For custom frameworks (Hono, Next.js route handlers, Koa, etc.):

```typescript
import { verifyToken, BKeyAuthError } from '@bkey/node';

try {
  const claims = await verifyToken(token, {
    issuer: 'https://api.bkey.id',
    scope: 'approve:payment',
  });
  // claims.sub, claims.scopes, claims.client_id, ...
} catch (err) {
  if (err instanceof BKeyAuthError) {
    console.error(`${err.code}: ${err.message}`); // err.status is 401 or 403
  }
}
```

## Configuration

All three entry points accept the same options:

| Option | Default | Description |
|---|---|---|
| `issuer` | `"https://api.bkey.id"` | BKey issuer URL — used for JWKS discovery and `iss` claim check (trailing slash tolerant) |
| `audience` | *(required**)* | Expected `aud` claim. Tokens without a matching audience are rejected |
| `scope` | *(required**)* | Required scope(s). String for one, `string[]` for ALL-of. Pass `[]` to explicitly accept any scope |
| `clockTolerance` | `30` | Clock skew tolerance in seconds for `exp` / `nbf` |
| `jwksCacheMaxAge` | `3600` | JWKS cache TTL in seconds |
| `jwksUrl` | derived from `issuer` | Override the JWKS endpoint URL (must be https://) |
| `jwks` | *(none)* | Pre-built JWKS — skips remote fetch. Validated to be Ed25519 public keys only. **Only set from trusted config.** |

**You must set at least one of `audience` or `scope`.** This prevents the confused-deputy attack where a token issued for a different app is replayed against yours. If you genuinely want to accept any scope, pass `scope: []` explicitly.

## What gets verified

1. **Signature** — EdDSA (Ed25519) against a key from BKey's JWKS endpoint. Algorithm is pinned to `EdDSA` to prevent algorithm confusion attacks (HS256-with-public-key, alg=none).
2. **Token shape** — three base64url segments, max 8 KB, no whitespace or smuggled content.
3. **Issuer** — must match `issuer` option, trailing-slash tolerant.
4. **Expiry + not-before** — with `clockTolerance` skew.
5. **Audience** — if `audience` option is set, token's `aud` must match.
6. **Scope** — token must have ALL scopes listed in the `scope` option (unless `scope: []`).
7. **Required claims** — `sub`, `iat`, `exp`, `iss` are required. Optional `aud`, `nbf`, `jti`, `client_id` are type-checked if present.
8. **Prototype pollution defense** — `__proto__`/`constructor`/`prototype` claim keys are stripped, returned object has a null prototype.

## Error codes

`BKeyAuthError.code` is one of:

| Code | HTTP status | When |
|---|---|---|
| `missing_token` | 401 | No `Authorization` header |
| `malformed_token` | 401 | Header present but not `Bearer <jwt>` |
| `invalid_signature` | 401 | Signature verification failed |
| `expired_token` | 401 | Token past `exp` |
| `invalid_issuer` | 401 | `iss` mismatch |
| `invalid_audience` | 401 | `aud` mismatch |
| `insufficient_scope` | 403 | Missing a required scope |
| `jwks_fetch_failed` | 401 | Could not fetch JWKS |

## License

Apache-2.0
