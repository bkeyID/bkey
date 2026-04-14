// copyright © 2025-2026 bkey inc. all rights reserved.

import type { NextFunction, Request, Response } from 'express';

import type { BKeyAuthClaims, VerifyTokenOptions } from './types.js';
import { BKeyAuthError } from './types.js';
import { extractBearerToken, verifyToken } from './verify.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * Verified BKey claims, attached by `requireBKeyAuth` middleware.
       * Only present on routes that ran the middleware and passed verification.
       *
       * Prefer `getBKeyAuth(req)` over non-null assertion (`req.bkeyAuth!`).
       * The helper throws if the middleware wasn't in front of the route —
       * a common bug when a developer adds a route but forgets the guard.
       */
      bkeyAuth?: BKeyAuthClaims;
    }
  }
}

/**
 * Express middleware that gates a route behind a verified BKey JWT.
 *
 * On success, the verified claims are available at `req.bkeyAuth` (or via
 * the `getBKeyAuth(req)` helper).
 *
 * On failure, responds with 401 (missing/invalid/expired token) or 403
 * (insufficient scope) and a JSON error body matching BKey's standard
 * error envelope: `{ success: false, error: { code, message } }`.
 *
 * **Security note on defaults.** By default this middleware accepts any
 * valid BKey-signed JWT — i.e., it only enforces signature, issuer, and
 * expiry. To avoid the confused-deputy class of attacks (a token issued for
 * a different app being replayed against yours), always set at least one of:
 *   - `audience`: the URL of your app — tokens without a matching `aud` are rejected
 *   - `scope`: the specific scope a token must carry
 *
 * @example
 * ```ts
 * import express from 'express';
 * import { requireBKeyAuth, getBKeyAuth } from '@bkey/node/express';
 *
 * const app = express();
 *
 * app.post(
 *   '/deploy',
 *   requireBKeyAuth({
 *     audience: 'https://my-app.example',
 *     scope: 'approve:deploy',
 *   }),
 *   (req, res) => {
 *     const auth = getBKeyAuth(req); // throws if middleware is missing
 *     console.log(`Approved by ${auth.sub}`);
 *     deploy();
 *     res.json({ ok: true });
 *   },
 * );
 * ```
 */
export function requireBKeyAuth(opts: VerifyTokenOptions = {}) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Defensively delete any pre-existing value to prevent spoofing by an
    // upstream middleware that mistakenly writes to req.bkeyAuth. Use delete
    // (not = undefined) so `'bkeyAuth' in req` also returns false.
    delete req.bkeyAuth;

    let claims: BKeyAuthClaims;
    try {
      const token = extractBearerToken(req.headers.authorization);
      claims = await verifyToken(token, opts);
    } catch (err) {
      const authErr =
        err instanceof BKeyAuthError
          ? err
          : new BKeyAuthError('invalid_signature', undefined, err);
      if (res.headersSent) return;
      res.status(authErr.status).json({
        success: false,
        error: { code: authErr.code, message: authErr.message },
      });
      return;
    }

    req.bkeyAuth = claims;
    next();
  };
}

/**
 * Safely access the verified BKey claims on a request. Throws if the
 * request was not processed by `requireBKeyAuth` — guards against the
 * classic bug of adding a route and forgetting the auth middleware.
 */
export function getBKeyAuth(req: Request): BKeyAuthClaims {
  if (!req.bkeyAuth) {
    throw new Error(
      'getBKeyAuth(req) called on a request without verified BKey claims. ' +
        'Did you forget to add requireBKeyAuth() middleware to this route?',
    );
  }
  return req.bkeyAuth;
}
