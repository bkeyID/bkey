/** All checks use the same request lifecycle. */
export type CaptchaMode = 'human' | 'age' | 'ageOfMajority';
/** Whole years; range endpoints and comparisons are inclusive. */
export type AgeRequirement =
  | { operator: 'eq' | 'gte' | 'lte'; value: number }
  | { operator: 'range'; min: number; max: number };
export type CaptchaCheck =
  | { mode: 'human'; age?: never }
  | { mode: 'ageOfMajority'; age?: never }
  | { mode: 'age'; age: AgeRequirement };
export type CaptchaTheme = 'light' | 'dark' | 'auto';
export type CaptchaState = 'idle' | 'loading' | 'pending' | 'scanned' | 'verified' | 'denied' | 'expired' | 'error';

/** UI contract used by the built-in backend connection and custom transports. */
export type CaptchaRequest = CaptchaCheck & {
  requestId: string;
  /** Exact app link supplied by the trusted integration. */
  qrPayload: string;
  /** ISO 8601 UTC expiry. */
  expiresAt: string;
  pollAfterMs?: number;
};
export type CaptchaStatus = CaptchaCheck & { requestId: string } & (
  | { status: 'pending' | 'scanned' | 'denied' | 'expired' }
  | { status: 'approved'; response: string; responseExpiresAt: string }
);
export interface CaptchaTransport {
  release?(): void;
  create(input: { signal: AbortSignal }): Promise<unknown>;
  status(input: { requestId: string; signal: AbortSignal }): Promise<unknown>;
}
export type CaptchaErrorCode = 'not-configured' | 'invalid-response' | 'request-failed';
export interface CaptchaErrorDetail { code: CaptchaErrorCode; }
