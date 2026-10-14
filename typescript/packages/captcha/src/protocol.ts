import type { AgeRequirement, CaptchaCheck, CaptchaRequest, CaptchaStatus } from './types.js';

/** A temporary HTTP limit. Keep the request credential until retry or expiry. */
export class CaptchaRateLimitError extends Error {
  constructor(readonly retryAfterMs: number) { super('Bkey: verification rate limited.'); }
}
export class CaptchaProtocolError extends Error {
  constructor(message: string) { super(message); this.name = 'CaptchaProtocolError'; }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CaptchaProtocolError('Expected an object.');
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new CaptchaProtocolError('Invalid string.');
  return value;
}
function years(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 150) {
    throw new CaptchaProtocolError('Age must be a whole number from 0 to 150.');
  }
  return value;
}
export function parseAgeRequirement(value: unknown): AgeRequirement {
  const data = object(value);
  if (data.operator === 'range') {
    const min = years(data.min), max = years(data.max);
    if (min > max) throw new CaptchaProtocolError('Age range is reversed.');
    return { operator: 'range', min, max };
  }
  if (data.operator === 'eq' || data.operator === 'gte' || data.operator === 'lte') {
    return { operator: data.operator, value: years(data.value) };
  }
  throw new CaptchaProtocolError('Unknown age operator.');
}
export function parseCaptchaCheck(value: unknown): CaptchaCheck {
  const data = object(value);
  if (data.mode === 'age') return { mode: 'age', age: parseAgeRequirement(data.age) };
  if (data.mode === 'human' || data.mode === 'ageOfMajority') {
    if (data.age !== undefined) throw new CaptchaProtocolError('This mode does not accept an age override.');
    return { mode: data.mode };
  }
  throw new CaptchaProtocolError('Unknown check mode.');
}
function matchingCheck(value: unknown, expected: CaptchaCheck): CaptchaCheck {
  const check = parseCaptchaCheck(value);
  if (JSON.stringify(check) !== JSON.stringify(parseCaptchaCheck(expected))) {
    throw new CaptchaProtocolError('Check conditions do not match this request.');
  }
  return check;
}
/** Text comes from parsed conditions, never from a website-supplied label. */
export function describeAgeRequirement(value: AgeRequirement): string {
  const age = parseAgeRequirement(value);
  if (age.operator === 'range') return `${age.min} to ${age.max}`;
  if (age.operator === 'gte') return `${age.value} or older`;
  if (age.operator === 'lte') return `${age.value} or younger`;
  return `exactly ${age.value}`;
}
/** Reject executable URLs. An adapter must also apply its trusted host policy. */
export function parseQrPayload(value: unknown): string {
  const payload = text(value, 1024);
  let url: URL;
  try { url = new URL(payload); } catch { throw new CaptchaProtocolError('Invalid QR link.'); }
  if (!['https:', 'bkey:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new CaptchaProtocolError('Unsupported QR link.');
  }
  return payload;
}
export function parseCaptchaRequest(value: unknown): CaptchaRequest {
  const data = object(value);
  const check = parseCaptchaCheck(data);
  const expiresAt = text(data.expiresAt);
  const expiry = Date.parse(expiresAt);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(expiresAt) || !Number.isFinite(expiry)) {
    throw new CaptchaProtocolError('Invalid expiry.');
  }
  if (data.pollAfterMs !== undefined && (typeof data.pollAfterMs !== 'number' || !Number.isFinite(data.pollAfterMs))) {
    throw new CaptchaProtocolError('Invalid polling interval.');
  }
  return {
    ...check, requestId: text(data.requestId),
    qrPayload: parseQrPayload(data.qrPayload), expiresAt,
    pollAfterMs: Math.min(10_000, Math.max(1_000, (data.pollAfterMs as number | undefined) ?? 1_500)),
  };
}
export function parseCaptchaStatus(value: unknown, request: CaptchaCheck & { requestId: string }): CaptchaStatus {
  const data = object(value);
  const check = matchingCheck(data, request);
  if (text(data.requestId) !== request.requestId) {
    throw new CaptchaProtocolError('Approval does not match this request.');
  }
  if (typeof data.status !== 'string' || !['pending', 'scanned', 'approved', 'denied', 'expired'].includes(data.status)) {
    throw new CaptchaProtocolError('Unknown approval status.');
  }
  if (data.status === 'approved') {
    const responseExpiresAt = text(data.responseExpiresAt);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(responseExpiresAt) || !Number.isFinite(Date.parse(responseExpiresAt))) {
      throw new CaptchaProtocolError('Invalid response expiry.');
    }
    return { ...check, requestId: request.requestId, status: 'approved', response: text(data.response, 2048), responseExpiresAt };
  }
  return { ...check, requestId: request.requestId, status: data.status as 'pending' | 'scanned' | 'denied' | 'expired' };
}
