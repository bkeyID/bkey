export * from './index.js';
import { ready, render, type RenderOptions } from './sdk.js';
// Capture during classic script evaluation. Never overwrite window.turnstile.
const script = document.currentScript as HTMLScriptElement | null;
const params = new URL(script?.src ?? location.href).searchParams;
ready(() => {
  const onload = params.get('onload');
  const globals = window as unknown as Record<string, unknown>;
  if (onload) {
    const callback = globals[onload];
    if (typeof callback !== 'function') throw new TypeError('Bkey: onload callback was not found.');
    callback();
  }
  if (params.get('render') === 'explicit') return;
  for (const host of document.querySelectorAll<HTMLElement>('.bkey-captcha')) {
    if (host.hasAttribute('data-mode') || host.hasAttribute('data-age') || host.hasAttribute('data-check')) throw new TypeError('Bkey: checks are configured on the sitekey, not in HTML.');
    const options: Record<string, unknown> = { sitekey: host.dataset.sitekey };
    for (const name of ['theme', 'size', 'execution', 'action', 'response-field-name']) {
      if (host.hasAttribute(`data-${name}`)) options[name] = host.getAttribute(`data-${name}`);
    }
    if (host.dataset.cdata !== undefined) options.cData = host.dataset.cdata;
    if (host.hasAttribute('data-response-field')) {
      const value = host.getAttribute('data-response-field');
      if (value !== 'true' && value !== 'false') throw new TypeError('Bkey: data-response-field must be true or false.');
      options['response-field'] = value === 'true';
    }
    for (const name of ['callback', 'error-callback', 'expired-callback', 'denied-callback']) {
      const value = host.getAttribute(`data-${name}`);
      if (value) {
        if (typeof globals[value] !== 'function') throw new TypeError(`Bkey: ${name} function was not found.`);
        options[name] = globals[value];
      }
    }
    render(host, options as unknown as RenderOptions);
  }
});
