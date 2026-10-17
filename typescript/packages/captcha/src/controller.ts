import { CaptchaProtocolError, CaptchaRateLimitError, parseCaptchaRequest, parseCaptchaStatus } from './protocol.js';
import { CaptchaView } from './view.js';
import type { CaptchaCheck, CaptchaErrorCode, CaptchaRequest, CaptchaState, CaptchaTransport } from './types.js';

export type ControllerEvent = { type: 'state'; state: CaptchaState } | { type: 'success'; response: string } | { type: 'error'; code: CaptchaErrorCode } | { type: 'expired' | 'denied' };
/** Owns one request lifecycle. The SDK owns registration, callbacks and forms. */
export class CaptchaController {
  state: CaptchaState = 'idle';
  private response = '';
  private responseExpiry = 0;
  private request?: CaptchaRequest;
  private check?: CaptchaCheck;
  private generation = 0;
  private abort?: AbortController;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private expiryTimer?: ReturnType<typeof setInterval>;
  private expanded = false;
  private disposed = false;
  constructor(
    private readonly view: CaptchaView,
    private readonly transport: CaptchaTransport,
    private readonly emit: (event: ControllerEvent) => void,
    private readonly deferred: boolean,
  ) { this.paint(); }
  private paint(): void { this.view.render(this.state, this.check, this.expanded, this.deferred && this.state === 'idle'); }
  private setState(state: CaptchaState): void { this.state = state; this.paint(); this.emit({ type: 'state', state }); }
  getResponse(): string {
    if (this.response && this.responseExpiry <= Date.now()) this.finish('expired');
    return this.response;
  }
  private stop(): void {
    this.generation++; this.abort?.abort(); this.abort = undefined; this.transport.release?.();
    clearTimeout(this.pollTimer); clearInterval(this.expiryTimer); this.retryNotBefore = 0;
  }
  reset(): void {
    this.stop(); this.request = undefined; this.check = undefined; this.response = ''; this.responseExpiry = 0; this.expanded = false;
    this.view.clear(); this.setState('idle');
  }
  dispose(): void { this.disposed = true; this.stop(); this.response = ''; this.view.clear(); this.view.dispose(); }
  private active(id: number): boolean { return !this.disposed && id === this.generation; }
  /** Prepare on render, but only reveal the QR when the user interacts. */
  async prepare(): Promise<void> { await this.start(false); }
  async execute(): Promise<void> {
    if (this.disposed || this.state === 'verified') return;
    this.expanded = true;
    if (this.state === 'pending' || this.state === 'scanned') {
      this.paint(); this.schedule(this.generation); return;
    }
    if (this.state === 'loading') { this.paint(); return; }
    await this.start(true);
  }
  private async start(expanded: boolean): Promise<void> {
    if (this.disposed) return;
    this.stop(); this.response = ''; this.request = undefined; this.check = undefined; this.expanded = expanded;
    const id = this.generation;
    this.abort = new AbortController(); this.setState('loading');
    try {
      const raw = await this.call(signal => this.transport.create({ signal }));
      if (!this.active(id)) return;
      this.request = parseCaptchaRequest(raw);
      this.check = this.request;
      if (Date.parse(this.request.expiresAt) <= Date.now()) { this.finish('expired'); return; }
      this.view.setLink(this.request.qrPayload); this.setState('pending');
      if (!this.active(id)) return;
      this.tick(); this.expiryTimer = setInterval(() => this.tick(), 250);
      if (this.expanded) this.schedule(id);
    } catch (error) { if (this.active(id)) this.fail(error instanceof CaptchaProtocolError ? 'invalid-response' : 'request-failed'); }
  }
  private call<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const parent = this.abort!.signal;
    const local = new AbortController();
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); parent.removeEventListener('abort', cancel); };
      const cancel = () => { cleanup(); local.abort(); reject(new Error('Cancelled or timed out.')); };
      const timer = setTimeout(cancel, 15_000);
      parent.addEventListener('abort', cancel, { once: true });
      if (parent.aborted) { cancel(); return; }
      Promise.resolve().then(() => operation(local.signal)).then(resolve, reject).finally(cleanup);
    });
  }
  private polling = false;
  private retryNotBefore = 0;
  private schedule(id: number, delay = this.request?.pollAfterMs ?? 1500): void {
    if (this.polling) return;
    clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => void this.poll(id), Math.max(delay, this.retryNotBefore - Date.now()));
  }
  private async poll(id: number): Promise<void> {
    const request = this.request;
    if (!request || !this.active(id) || this.polling) return;
    this.polling = true;
    let retryAfterMs: number | undefined;
    try {
      const raw = await this.call(signal => this.transport.status({ requestId: request.requestId, signal }));
      if (!this.active(id)) return;
      if (Date.parse(request.expiresAt) <= Date.now()) { this.finish('expired'); return; }
      const status = parseCaptchaStatus(raw, request);
      if (status.status === 'approved') {
        if (Date.parse(status.responseExpiresAt) <= Date.now()) { this.finish('expired'); return; }
        this.response = status.response; this.responseExpiry = Date.parse(status.responseExpiresAt);
        this.finish('verified');
        if (this.response) this.emit({ type: 'success', response: this.response });
      } else if (status.status === 'denied' || status.status === 'expired') this.finish(status.status);
      else this.setState(this.state === 'scanned' ? 'scanned' : status.status);
    } catch (error) {
      if (this.active(id)) {
        if (error instanceof CaptchaRateLimitError) {
          retryAfterMs = error.retryAfterMs;
          this.retryNotBefore = Date.now() + retryAfterMs;
        }
        else this.fail(error instanceof CaptchaProtocolError ? 'invalid-response' : 'request-failed');
      }
    }
    finally {
      this.polling = false;
      if (this.active(id) && (this.state === 'pending' || this.state === 'scanned')) this.schedule(id, retryAfterMs);
    }
  }
  private tick(): void {
    const expiry = this.state === 'verified' ? this.responseExpiry : this.request ? Date.parse(this.request.expiresAt) : 0;
    if (!expiry) return;
    const remaining = Math.ceil((expiry - Date.now()) / 1000);
    if (remaining <= 0) this.finish('expired'); else this.view.countdown(remaining);
  }
  private finish(state: 'verified' | 'denied' | 'expired' | 'error'): void {
    const focused = this.view.focused;
    this.stop(); this.expanded = false;
    if (state !== 'verified') { this.response = ''; this.responseExpiry = 0; }
    this.view.clear(); this.setState(state);
    if (focused) this.view.focus();
    if (this.disposed) return;
    if (state === 'verified' && this.state === 'verified' && this.response) this.expiryTimer = setInterval(() => this.tick(), 250);
    if (state === 'expired' || state === 'denied') this.emit({ type: state });
  }
  private fail(code: CaptchaErrorCode): void { this.finish('error'); this.emit({ type: 'error', code }); }
}
