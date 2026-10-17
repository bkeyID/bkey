import QRCode from 'qrcode';
import { styles } from './styles.js';
import { describeAgeRequirement } from './protocol.js';
import type { CaptchaCheck, CaptchaState, CaptchaTheme } from './types.js';
const check = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m4 10 4 4 8-8" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
/** Internal DOM view. No custom element or second public API. */
export class CaptchaView {
  readonly element = document.createElement('div');
  private readonly shadowRoot = this.element.attachShadow({ mode: 'open' });
  private readonly motion = matchMedia('(prefers-reduced-motion: reduce)');
  private readonly updateMotion = () => this.element.toggleAttribute('reduced-motion', this.motion.matches);
  dispose(): void { this.motion.removeEventListener('change', this.updateMotion); }
  constructor(theme: CaptchaTheme, size: 'normal' | 'flexible', start: () => void, cancel: () => void) {
    this.element.setAttribute('theme', theme);
    // Mirror the preference on the host for consistent shadow-root updates in WebKit.
    this.updateMotion();
    this.motion.addEventListener('change', this.updateMotion);
    if (size === 'flexible') this.element.style.width = '100%';
    const root = this.shadowRoot;
      root.innerHTML = `<style>${styles}</style><div class="shell" part="container" data-state="idle">
        <div class="header"><button class="trigger" type="button" role="checkbox" aria-checked="false" aria-expanded="false" aria-controls="panel">
          <span class="mark" aria-hidden="true"><span class="tick">${check}</span><svg class="alert" viewBox="0 0 20 20" fill="none"><path d="M10 5v6m0 3v.2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></span>
          <span class="copy"><span class="label"></span><span class="hint"></span></span>
        </button><span class="brand" aria-label="bkey">bkey<small>verification</small></span><button class="close" type="button" aria-label="Cancel verification" hidden><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button></div>
        <div class="panel" id="panel" inert><p class="intro">A quick scan. Then you’re in.</p><p class="description"></p><div class="qr-wrap"><div class="qr" role="img" aria-label="Scan this QR code with the bkey app"></div><div class="phone-state" hidden><svg viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="10" y="3" width="20" height="34" rx="5"/><path d="M17 8h6M18 32h4"/><path d="m15 20 3.5 3.5 6.5-7"/></svg><span>Finish in the bkey app</span></div></div><div class="waiting"><span class="wait-label">Waiting for your phone</span><span class="countdown"></span></div><a class="open-app" rel="noopener noreferrer">Open bkey on this device <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 12 12 4M4 4h8v8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></a><p class="privacy">This site receives only the verification result.</p></div>
        </div><span class="sr" role="status" aria-live="polite" aria-atomic="true"></span>`;

    this.el<HTMLButtonElement>('.trigger').addEventListener('click', start);
    this.el<HTMLButtonElement>('.close').addEventListener('click', () => { cancel(); this.focus(); });
    root.addEventListener('keydown', event => {
      if ((event as KeyboardEvent).key === 'Escape' && !this.el<HTMLElement>('.close').hidden) {
        event.preventDefault(); cancel(); this.focus();
      }
    });
  }
  get focused(): boolean { return Boolean(this.shadowRoot.activeElement); }
  focus(): void { this.el<HTMLButtonElement>('.trigger').focus({ preventScroll: true }); }
  clear(): void { this.el('.qr').replaceChildren(); this.el('.open-app').removeAttribute('href'); }
  setLink(payload: string): void { this.drawQr(payload); this.el<HTMLAnchorElement>('.open-app').href = payload; }
  countdown(seconds: number): void { this.el('.countdown').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; }
  private el<T extends Element = HTMLElement>(selector: string): T { return this.shadowRoot.querySelector<T>(selector)!; }
  drawQr(payload: string): void {
    const qr = QRCode.create(payload, { errorCorrectionLevel: 'M' });
    const size = qr.modules.size;
    const path: string[] = [];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (qr.modules.get(y, x)) path.push(`M${x + 4} ${y + 4}h1v1h-1z`);
    }
    // The only interpolated values are encoder-generated numbers. Payload text is never HTML.
    this.el('.qr').innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size + 8} ${size + 8}" shape-rendering="crispEdges" aria-hidden="true"><rect width="100%" height="100%" fill="white"/><path d="${path.join('')}" fill="#17151b"/></svg>`;
  }
  render(state: CaptchaState, check: CaptchaCheck | undefined, expanded: boolean, disabled: boolean): void {
    const active = expanded && (state === 'pending' || state === 'scanned');
    const busy = active || state === 'loading';
    const displayedState = state === 'pending' && !expanded ? 'idle' : state;
    const ageText = check?.mode === 'age' ? describeAgeRequirement(check.age) : '';
    const idleLabel = !check ? 'Verify with bkey' : check.mode === 'human' ? 'I’m not a robot'
      : check.mode === 'ageOfMajority' ? 'Verify I’m an adult' : check.age.operator === 'range' ? `Verify age: ${ageText}` : `Verify I’m ${ageText}`;
    const labels: Record<CaptchaState, [string, string]> = {
      idle: [idleLabel, check?.mode === 'ageOfMajority' ? 'Based on your detected location' : ''],
      loading: ['Getting things ready', 'Connecting to bkey…'],
      pending: ['Verify with bkey', 'Private. Just a moment.'],
      scanned: ['Check your phone', 'Complete your face check'],
      verified: [check?.mode === 'human' ? 'Verified' : check?.mode === 'ageOfMajority' ? 'Adult status verified' : 'Age verified', check?.mode === 'human' ? 'You’re good to go' : check?.mode === 'ageOfMajority' ? 'For your detected location' : ageText],
      denied: ['Not approved', 'Select to try again'],
      expired: ['Verification expired', 'Select to try again'],
      error: ['Couldn’t connect', 'Select to try again'],
    };
    const [label, hint] = labels[displayedState];
    const shell = this.el('.shell'); shell.setAttribute('data-state', displayedState); shell.classList.toggle('expanded', active);
    this.el('.label').textContent = label; this.el('.hint').textContent = hint;
    const trigger = this.el<HTMLButtonElement>('.trigger');
    // Keep the control focusable during polling and after success.
    trigger.setAttribute('aria-disabled', String(disabled || busy || state === 'verified'));
    trigger.disabled = disabled;
    trigger.setAttribute('aria-checked', state === 'verified' ? 'true' : busy ? 'mixed' : 'false');
    trigger.setAttribute('aria-expanded', String(active));
    trigger.setAttribute('aria-label', [label, hint].filter(Boolean).join('. '));
    this.el<HTMLElement>('.panel').inert = !active;
    this.el<HTMLElement>('.brand').hidden = busy;
    this.el<HTMLElement>('.close').hidden = !busy;
    this.el<HTMLElement>('.phone-state').hidden = state !== 'scanned';
    this.el('.description').textContent = check?.mode === 'age' ? `Confirm age: ${ageText} in the bkey app.` : check?.mode === 'ageOfMajority' ? 'Confirm adult status in the bkey app.' : 'Scan with the bkey app to verify it’s you.';
    this.el('.wait-label').textContent = state === 'scanned' ? 'Waiting for approval' : 'Waiting for your phone';
    const announcement = active ? `${label}. ${this.el('.description').textContent}` : `${label}. ${hint}`;
    if (this.el('.sr').textContent !== announcement) this.el('.sr').textContent = announcement;
  }
}
