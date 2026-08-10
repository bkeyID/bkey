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
  /** bkey issuer base. Default: https://id.bkey.id */
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
  checks: ['pkce', 'nonce', 'state'];
  idToken: true;
  client: { id_token_signed_response_alg: string; token_endpoint_auth_method: string };
  profile: (profile: { sub: string }) => { id: string };
  style: { brandColor: string };
}

// MUST be the host whose discovery document declares itself as the issuer, and
// which signs the id_token `iss` claim — that is `id.bkey.id`. `auth.bkey.id`
// also serves a discovery document, but that document declares
// `"issuer": "https://id.bkey.id"`, so configuring `auth.bkey.id` fails the
// mandatory OIDC Discovery §4.3 issuer-equality check in every conformant
// client (Auth.js/oauth4webapi, and fetchDiscovery in ./client.ts) before a
// single request reaches the authorization endpoint. Do not "simplify" this
// back to the vanity hostname.
export const BKEY_DEFAULT_ISSUER = 'https://id.bkey.id';

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
    // state (CSRF) alongside PKCE + nonce; Auth.js round-trips it through the
    // signed callback cookie (PR #32 review).
    checks: ['pkce', 'nonce', 'state'],
    idToken: true,
    // bkey signs EdDSA by default; if your client was registered with RS256,
    // pass issuer/client overrides accordingly. `token_endpoint_auth_method`
    // MUST match how the client is registered and what the IdP supports:
    // confidential clients register `client_secret_post` (the only secret
    // method the bkey token endpoint accepts), while a PUBLIC client (no
    // clientSecret — PKCE only, registered auth method `none`) must use `none`
    // or Auth.js would try to send a non-existent secret. Without pinning this
    // Auth.js defaults to `client_secret_basic`, which fails for both (PR #32).
    client: {
      id_token_signed_response_alg: 'EdDSA',
      token_endpoint_auth_method: options.clientSecret ? 'client_secret_post' : 'none',
    },
    profile: (profile) => ({ id: profile.sub }),
    style: { brandColor: '#B001B0' },
  };
}
