// copyright © 2025-2026 bkey inc. all rights reserved.

import type { BKey } from '@bkey/sdk';

/**
 * Thin client for the "Login with bkey" OAuth client-management API, called
 * with the signed-in human's CLI token:
 *
 *   POST   /oauth/register                      born-owned registration (RFC 7591)
 *   GET    /oauth/register/:id                  metadata (RFC 7592)
 *   PATCH  /oauth/register/:id                  update
 *   DELETE /oauth/register/:id                  revoke
 *   POST   /oauth/register/:id/rotate-secret    new secret, returned once
 *   PUT    /oauth/register/:id/logo             raw PNG
 *   POST   /oauth/register/:id/claim            claim an anonymous registration
 *   GET    /v1/oauth/clients                    the caller's owned clients
 *   GET    /v1/oauth/clients/:id/analytics      login funnel
 *   POST   /v1/oauth/clients/:id/enable-personas
 *
 * The backend admits CLI device-authorization tokens on every one of these
 * (the same "user principal" predicate the developer dashboard uses); an
 * agent-mode client_credentials token is rejected with permission_denied.
 * Errors arrive in two shapes — the API's nested `{error:{code,message}}` and
 * the RFC 7591 flat `{error, error_description}` — both are mapped here.
 */

export interface OwnedClientSummary {
  clientId: string;
  name: string;
  description: string | null;
  clientType: string;
  grantTypes: string[];
  createdAt: string;
  revokedAt: string | null;
  personaSupport?: boolean;
  logoUri?: string | null;
}

export interface ClientMetadata {
  client_id: string;
  client_id_issued_at?: number;
  registration_client_uri: string;
  client_name?: string;
  logo_uri?: string;
  redirect_uris: string[];
  post_logout_redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  id_token_signed_response_alg: string;
  scope?: string;
}

export interface RegisteredClient extends ClientMetadata {
  client_secret?: string;
  client_secret_expires_at?: number;
  registration_access_token?: string;
}

export interface RotatedSecret {
  client_id: string;
  client_secret: string;
  client_secret_expires_at: number;
  old_secret_expires_at: string | null;
}

export interface Funnel {
  started_7d: number;
  completed_7d: number;
  started_30d: number;
  completed_30d: number;
}

export class ClientApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ClientApiError';
    this.code = code;
    this.status = status;
  }
}

function errorFrom(body: unknown, status: number): ClientApiError {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    if (b.error && typeof b.error === 'object') {
      const nested = b.error as Record<string, unknown>;
      return new ClientApiError(
        String(nested.code ?? 'error'),
        String(nested.message ?? `HTTP ${status}`),
        status,
      );
    }
    if (typeof b.error === 'string') {
      return new ClientApiError(
        b.error,
        typeof b.error_description === 'string' ? b.error_description : b.error,
        status,
      );
    }
  }
  return new ClientApiError('http_error', `HTTP ${status}`, status);
}

/** The SDK client plus the base URL it was built with (the SDK keeps its own private). */
export interface ClientApi {
  api: BKey;
  baseUrl: string;
}

async function call<T>(
  { api, baseUrl }: ClientApi,
  method: string,
  path: string,
  init: { json?: unknown; raw?: { body: Uint8Array<ArrayBuffer>; contentType: string } } = {},
): Promise<T> {
  const token = await api.getValidToken();
  const base = baseUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
  let body: BodyInit | undefined;
  if (init.raw) {
    headers['Content-Type'] = init.raw.contentType;
    body = new Blob([init.raw.body], { type: init.raw.contentType });
  } else if (init.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.json);
  }
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }
  if (!res.ok) throw errorFrom(parsed, res.status);
  return parsed as T;
}

const reg = (clientId: string) => `/oauth/register/${encodeURIComponent(clientId)}`;
const owned = (clientId: string) => `/v1/oauth/clients/${encodeURIComponent(clientId)}`;

export function listClients(api: ClientApi): Promise<OwnedClientSummary[]> {
  return call<OwnedClientSummary[]>(api, 'GET', '/v1/oauth/clients');
}

export function getClient(api: ClientApi, clientId: string): Promise<ClientMetadata> {
  return call<ClientMetadata>(api, 'GET', reg(clientId));
}

export interface CreateClientInput {
  clientName: string;
  redirectUris: string[];
  postLogoutRedirectUris?: string[];
  tokenEndpointAuthMethod: 'client_secret_post' | 'none';
  idTokenSignedResponseAlg?: string;
}

export function createClient(api: ClientApi, input: CreateClientInput): Promise<RegisteredClient> {
  return call<RegisteredClient>(api, 'POST', '/oauth/register', {
    json: {
      client_name: input.clientName,
      redirect_uris: input.redirectUris,
      ...(input.postLogoutRedirectUris?.length
        ? { post_logout_redirect_uris: input.postLogoutRedirectUris }
        : {}),
      token_endpoint_auth_method: input.tokenEndpointAuthMethod,
      grant_types: ['authorization_code'],
      response_types: ['code'],
      scope: 'openid',
      ...(input.idTokenSignedResponseAlg
        ? { id_token_signed_response_alg: input.idTokenSignedResponseAlg }
        : {}),
    },
  });
}

export interface UpdateClientInput {
  clientName?: string;
  redirectUris?: string[];
  postLogoutRedirectUris?: string[];
  idTokenSignedResponseAlg?: string;
}

export function updateClient(
  api: ClientApi,
  clientId: string,
  input: UpdateClientInput,
): Promise<ClientMetadata> {
  return call<ClientMetadata>(api, 'PATCH', reg(clientId), {
    json: {
      ...(input.clientName !== undefined ? { client_name: input.clientName } : {}),
      ...(input.redirectUris !== undefined ? { redirect_uris: input.redirectUris } : {}),
      ...(input.postLogoutRedirectUris !== undefined
        ? { post_logout_redirect_uris: input.postLogoutRedirectUris }
        : {}),
      ...(input.idTokenSignedResponseAlg !== undefined
        ? { id_token_signed_response_alg: input.idTokenSignedResponseAlg }
        : {}),
    },
  });
}

export function rotateSecret(
  api: ClientApi,
  clientId: string,
  graceHours: number,
): Promise<RotatedSecret> {
  return call<RotatedSecret>(api, 'POST', `${reg(clientId)}/rotate-secret`, {
    json: { grace_hours: graceHours },
  });
}

export function revokeClient(api: ClientApi, clientId: string): Promise<void> {
  return call<void>(api, 'DELETE', reg(clientId));
}

export function uploadLogo(
  api: ClientApi,
  clientId: string,
  png: Uint8Array<ArrayBuffer>,
): Promise<{ logo_uri: string }> {
  return call<{ logo_uri: string }>(api, 'PUT', `${reg(clientId)}/logo`, {
    raw: { body: png, contentType: 'image/png' },
  });
}

export function claimClient(
  api: ClientApi,
  clientId: string,
  registrationAccessToken: string,
): Promise<ClientMetadata> {
  return call<ClientMetadata>(api, 'POST', `${reg(clientId)}/claim`, {
    json: { registration_access_token: registrationAccessToken },
  });
}

export function analytics(
  api: ClientApi,
  clientId: string,
): Promise<{ client_id: string; funnel: Funnel }> {
  return call(api, 'GET', `${owned(clientId)}/analytics`);
}

export function enablePersonas(
  api: ClientApi,
  clientId: string,
): Promise<{ client_id: string; persona_support: boolean }> {
  return call(api, 'POST', `${owned(clientId)}/enable-personas`);
}
