import type { Transport } from './sdk.js';
import { CaptchaProtocolError, CaptchaRateLimitError, parseCaptchaRequest } from './protocol.js';

export const DEFAULT_API_URL = 'https://api.bkey.id';
export function backendUrl(value: string): string {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new TypeError('Bkey: apiUrl must be an HTTPS origin (HTTP is allowed on localhost).');
  }
  return url.origin;
}
/** Each widget owns its polling credential. No account or site secret is sent. */
export function createBackendTransport(apiUrl: string): Transport {
  let session: { requestId: string; pollToken: string } | undefined;
  async function request(path: string, options: RequestInit): Promise<Record<string, unknown>> {
    const response = await fetch(`${apiUrl}/v1/captcha/requests${path}`, {
      ...options, credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
    });
    if (response.status === 429) {
      const header = response.headers.get('Retry-After')?.trim();
      const delay = header && /^\d+$/.test(header)
        ? Number(header) * 1000
        : header ? Date.parse(header) - Date.now() : NaN;
      throw new CaptchaRateLimitError(Number.isFinite(delay) ? Math.min(2_147_483_647, Math.max(1000, delay)) : 5000);
    }
    if (!response.ok) throw new Error('Bkey: verification request failed.');
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CaptchaProtocolError('Invalid backend response.');
    return body as Record<string, unknown>;
  }
  return {
    release() { session = undefined; },
    async create({ sitekey, signal }) {
      session = undefined;
      const body = await request('', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sitekey }), signal });
      const parsed = parseCaptchaRequest(body);
      if (!/^[0-9a-f-]{36}$/i.test(parsed.requestId) || typeof body.pollToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.pollToken)) {
        throw new CaptchaProtocolError('Invalid polling credential.');
      }
      signal.throwIfAborted();
      session = { requestId: parsed.requestId, pollToken: body.pollToken };
      return parsed;
    },
    async status({ requestId, signal }) {
      const current = session;
      if (!current || current.requestId !== requestId) throw new CaptchaProtocolError('Unknown polling request.');
      const body = await request(`/${encodeURIComponent(requestId)}/status`, {
        method: 'GET', headers: { 'X-Bkey-Poll-Token': current.pollToken }, signal,
      });
      return body.status === 'approved'
        ? { ...body, response: body.token, responseExpiresAt: body.expiresAt }
        : body;
    },
  };
}
