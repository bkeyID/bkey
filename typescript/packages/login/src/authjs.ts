/**
 * Auth.js (NextAuth v5) provider preset for "Login with bkey".
 *
 * ```ts
 * // auth.ts
 * import NextAuth from 'next-auth';
 * import { BkeyProvider } from '@bkey/login/authjs';
 *
 * export const { handlers, auth, signIn, signOut } = NextAuth({
 *   providers: [
 *     BkeyProvider({
 *       clientId: process.env.BKEY_CLIENT_ID!,
 *       clientSecret: process.env.BKEY_CLIENT_SECRET!,
 *     }),
 *   ],
 * });
 * ```
 *
 * Structural-typed (no dependency on next-auth): the returned object is a
 * plain Auth.js OIDC provider config. Auth.js handles discovery, PKCE,
 * nonce, and id_token verification via its own oauth4webapi stack — which
 * supports bkey's EdDSA id_tokens out of the box.
 */

export interface BkeyProviderOptions {
  clientId: string;
  /** Omit for public (PKCE-only) clients registered with auth method 'none'. */
  clientSecret?: string;
  /** bkey issuer base. Default: https://auth.bkey.id */
  issuer?: string;
}

/** The subset of the Auth.js OIDC provider config shape this preset emits. */
export interface BkeyAuthjsProvider {
  id: string;
  name: string;
  type: 'oidc';
  issuer: string;
  clientId: string;
  clientSecret?: string;
  authorization: { params: { scope: string } };
  checks: ['pkce', 'nonce'];
  idToken: true;
  client: { id_token_signed_response_alg: string };
  profile: (profile: { sub: string }) => { id: string };
  style: { brandColor: string };
}

export const BKEY_DEFAULT_ISSUER = 'https://auth.bkey.id';

export function BkeyProvider(options: BkeyProviderOptions): BkeyAuthjsProvider {
  return {
    id: 'bkey',
    name: 'bkey',
    type: 'oidc',
    issuer: options.issuer ?? BKEY_DEFAULT_ISSUER,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    // v1 shares exactly one claim: sub — the user's stable pseudonymous DID.
    authorization: { params: { scope: 'openid' } },
    checks: ['pkce', 'nonce'],
    idToken: true,
    // bkey signs EdDSA by default; if your client was registered with RS256,
    // pass issuer/client overrides accordingly.
    client: { id_token_signed_response_alg: 'EdDSA' },
    profile: (profile) => ({ id: profile.sub }),
    style: { brandColor: '#B001B0' },
  };
}
