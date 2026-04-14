// copyright © 2025-2026 bkey inc. all rights reserved.

import fp from 'fastify-plugin';
import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from 'fastify';

import type {
  BKeyAdvancedVerifyConfig,
  BKeyAuthClaims,
  VerifyTokenOptions,
} from './types.js';
import { BKeyAuthError } from './types.js';
import { extractBearerToken, verifyToken } from './verify.js';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Verified BKey claims, attached by `requireBKeyAuth` preHandler.
     * Only present on routes that ran the hook and passed verification.
     *
     * Prefer `getBKeyAuth(req)` over non-null assertion (`req.bkeyAuth!`).
     */
    bkeyAuth?: BKeyAuthClaims;
  }

  interface FastifyInstance {
    /**
     * Create a preHandler hook that verifies the BKey JWT on the incoming
     * request. Use in a route's `onRequest` or `preHandler` array.
     */
    requireBKeyAuth: (opts?: VerifyTokenOptions) => preHandlerAsyncHookHandler;
  }
}

export type BKeyAuthPluginOptions = BKeyAdvancedVerifyConfig;

/**
 * Fastify plugin that registers `app.requireBKeyAuth(opts)` — a factory for
 * preHandler hooks that verify BKey JWTs.
 *
 * Wrapped with `fastify-plugin` so the decorator is visible outside the
 * plugin's encapsulation context — otherwise sibling plugins wouldn't see
 * `app.requireBKeyAuth`, leading to developers disabling auth "because it
 * doesn't work".
 *
 * **Security note on defaults.** See `requireBKeyAuth` in `./express` —
 * the same guidance applies: set at least one of `audience` or `scope` to
 * avoid accepting tokens issued for other apps.
 *
 * @example
 * ```ts
 * import fastify from 'fastify';
 * import { bkeyAuth, getBKeyAuth } from '@bkey/node/fastify';
 *
 * const app = fastify();
 * await app.register(bkeyAuth, { issuer: 'https://api.bkey.id' });
 *
 * app.post('/deploy', {
 *   preHandler: [app.requireBKeyAuth({
 *     audience: 'https://my-app.example',
 *     scope: 'approve:deploy',
 *   })],
 * }, async (req) => {
 *   const auth = getBKeyAuth(req);
 *   return { approvedBy: auth.sub };
 * });
 * ```
 */
const bkeyAuthPlugin: FastifyPluginAsync<BKeyAuthPluginOptions> = async (app, opts = {}) => {
  const defaultConfig: BKeyAdvancedVerifyConfig = {
    issuer: opts.issuer,
    audience: opts.audience,
    clockTolerance: opts.clockTolerance,
    jwksCacheMaxAge: opts.jwksCacheMaxAge,
    jwksUrl: opts.jwksUrl,
    jwks: opts.jwks,
  };

  app.decorate('requireBKeyAuth', (routeOpts: VerifyTokenOptions = {}) => {
    const merged: VerifyTokenOptions = { ...defaultConfig, ...routeOpts };
    return async (req: FastifyRequest, reply: FastifyReply) => {
      // Defensively delete any pre-existing value. Use delete (not = undefined)
      // so `'bkeyAuth' in req` also returns false.
      delete req.bkeyAuth;

      let claims: BKeyAuthClaims;
      try {
        const token = extractBearerToken(req.headers.authorization);
        claims = await verifyToken(token, merged);
      } catch (err) {
        const authErr =
          err instanceof BKeyAuthError
            ? err
            : new BKeyAuthError('invalid_signature', undefined, err);
        if (reply.sent) return;
        reply.status(authErr.status).send({
          success: false,
          error: { code: authErr.code, message: authErr.message },
        });
        return;
      }

      req.bkeyAuth = claims;
    };
  });
};

export const bkeyAuth = fp(bkeyAuthPlugin, {
  name: '@bkey/node-fastify',
  fastify: '4.x || 5.x',
});

export default bkeyAuth;

/**
 * Safely access the verified BKey claims on a request. Throws if the
 * request was not processed by a `requireBKeyAuth` hook.
 */
export function getBKeyAuth(req: FastifyRequest): BKeyAuthClaims {
  if (!req.bkeyAuth) {
    throw new Error(
      'getBKeyAuth(req) called on a request without verified BKey claims. ' +
        'Did you forget to add app.requireBKeyAuth() to this route?',
    );
  }
  return req.bkeyAuth;
}
