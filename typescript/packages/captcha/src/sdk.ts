import { backendUrl, createBackendTransport, DEFAULT_API_URL } from './backend.js';
import { CaptchaController, type ControllerEvent } from './controller.js';
import { CaptchaView } from './view.js';
import type { CaptchaErrorCode, CaptchaTheme } from './types.js';

export interface SiteContext { sitekey: string; action?: string; cData?: string; }
/** Service connection, supplied once. It is not part of individual render options. */
export interface Transport {
  release?(): void;
  create(input: SiteContext & { signal: AbortSignal }): Promise<unknown>;
  status(input: SiteContext & { requestId: string; signal: AbortSignal }): Promise<unknown>;
}
export type RenderOptions = SiteContext & {
  theme?: CaptchaTheme;
  size?: 'normal' | 'flexible';
  execution?: 'render' | 'execute';
  callback?: (response: string) => void;
  'error-callback'?: (code: CaptchaErrorCode) => void;
  'expired-callback'?: () => void;
  'denied-callback'?: () => void;
  'response-field'?: boolean;
  'response-field-name'?: string;
};
export type WidgetTarget = string | HTMLElement;
interface Widget {
  id: string;
  host: HTMLElement;
  view: CaptchaView;
  controller: CaptchaController;
  field?: HTMLInputElement;
  listeners: AbortController;
  observer: MutationObserver;
  execution: 'render' | 'execute';
}
let service: Transport | undefined;
let apiUrl = DEFAULT_API_URL;
const widgets = new Map<string, Widget>();
const hosts = new WeakMap<HTMLElement, string>();

export type ServiceConfig = { apiUrl?: string; transport?: never } | { transport: Transport; apiUrl?: never };
export function configure(config: ServiceConfig): void {
  if (widgets.size) throw new Error('Bkey: remove existing widgets before changing the service connection.');
  if (!config || (config.transport !== undefined && config.apiUrl !== undefined)) throw new TypeError('Bkey: choose apiUrl or transport.');
  if (config.transport !== undefined) {
    if (typeof config.transport.create !== 'function' || typeof config.transport.status !== 'function') throw new TypeError('Bkey: transport requires create and status methods.');
    service = config.transport;
  } else {
    apiUrl = backendUrl(config.apiUrl ?? DEFAULT_API_URL);
    service = undefined;
  }
}

function containerFor(target: WidgetTarget): HTMLElement {
  const element = typeof target === 'string' ? document.querySelector(target) : target;
  if (!(element instanceof HTMLElement)) throw new TypeError('Bkey: container was not found.');
  return element;
}
function resolve(target?: WidgetTarget): Widget {
  let widget: Widget | undefined;
  if (target === undefined) widget = widgets.values().next().value;
  else if (typeof target === 'string' && widgets.has(target)) widget = widgets.get(target);
  else {
    const id = hosts.get(containerFor(target));
    if (id) widget = widgets.get(id);
  }
  if (!widget) throw new Error('Bkey: widget was not found or has been removed.');
  return widget;
}
function sync(widget: Widget): string {
  const response = widget.controller.getResponse();
  if (widget.field) widget.field.value = response;
  return response;
}
function validate(options: RenderOptions): void {
  if (!options || typeof options.sitekey !== 'string' || !options.sitekey.trim()) throw new TypeError('Bkey: a public sitekey is required.');
  const supported = new Set(['sitekey', 'action', 'cData', 'theme', 'size', 'execution', 'callback', 'error-callback', 'expired-callback', 'denied-callback', 'response-field', 'response-field-name']);
  for (const key of Object.keys(options)) if (!supported.has(key)) throw new TypeError(`Bkey: unsupported option ${key}.`);
  if (options.theme !== undefined && !['light', 'dark', 'auto'].includes(options.theme)) throw new TypeError('Bkey: invalid theme.');
  if (options.size !== undefined && !['normal', 'flexible'].includes(options.size)) throw new TypeError('Bkey: supported sizes are normal and flexible.');
  if (options.execution !== undefined && !['render', 'execute'].includes(options.execution)) throw new TypeError('Bkey: invalid execution mode.');
  if (options.action !== undefined && (typeof options.action !== 'string' || !/^[a-zA-Z0-9_-]{1,32}$/.test(options.action))) throw new TypeError('Bkey: action must use 1 to 32 letters, digits, underscores or hyphens.');
  if (options.cData !== undefined && (typeof options.cData !== 'string' || !/^[a-zA-Z0-9_-]{1,255}$/.test(options.cData))) throw new TypeError('Bkey: cData must use 1 to 255 letters, digits, underscores or hyphens.');
  if (options['response-field'] !== undefined && typeof options['response-field'] !== 'boolean') throw new TypeError('Bkey: response-field must be a boolean.');
  if (options['response-field-name'] !== undefined && (typeof options['response-field-name'] !== 'string' || !options['response-field-name'].trim())) throw new TypeError('Bkey: response-field-name must not be empty.');
  for (const key of ['callback', 'error-callback', 'expired-callback', 'denied-callback'] as const) {
    if (options[key] !== undefined && typeof options[key] !== 'function') throw new TypeError(`Bkey: ${key} must be a function.`);
  }
}
export function render(container: WidgetTarget, options: RenderOptions): string {
  if (typeof document === 'undefined') throw new Error('Bkey: render requires a browser.');
  validate(options);
  const host = containerFor(container);
  if (!host.isConnected) throw new Error('Bkey: attach the container before rendering.');
  if (hosts.has(host)) throw new Error('Bkey: this container already has a widget.');
  if (!service && (options.action !== undefined || options.cData !== undefined)) throw new TypeError('Bkey: the backend does not yet support action or cData.');
  const transport = service ?? createBackendTransport(apiUrl);
  const site: SiteContext = { sitekey: options.sitekey, ...(options.action === undefined ? {} : { action: options.action }), ...(options.cData === undefined ? {} : { cData: options.cData }) };
  const callbacks = { success: options.callback, error: options['error-callback'], expired: options['expired-callback'], denied: options['denied-callback'] };
  const execution = options.execution ?? 'render';
  const id = `bkey-widget-${crypto.randomUUID()}`;
  let controller: CaptchaController;
  const view = new CaptchaView(options.theme ?? 'auto', options.size ?? 'normal', () => { void controller.execute(); }, () => reset(id));
  view.element.id = id;
  const field = options['response-field'] === false ? undefined : document.createElement('input');
  if (field) { field.type = 'hidden'; field.name = options['response-field-name'] ?? 'bkey-response'; field.value = ''; }
  const notify = (event: ControllerEvent) => {
    const widget = widgets.get(id);
    if (!widget) return;
    const response = sync(widget);
    if (event.type === 'success' && response) callbacks.success?.(response);
    else if (event.type === 'error') callbacks.error?.(event.code);
    else if (event.type === 'expired') callbacks.expired?.();
    else if (event.type === 'denied') callbacks.denied?.();
  };
  controller = new CaptchaController(view, {
    release: () => transport.release?.(),
    create: input => transport.create({ ...input, ...site }),
    status: input => transport.status({ ...input, ...site }),
  }, notify, execution === 'execute');
  const listeners = new AbortController();
  const observer = new MutationObserver(() => {
    if (widgets.has(id) && (!host.isConnected || view.element.parentElement !== host)) remove(id);
  });
  const widget: Widget = { id, host, view, controller, field, listeners, observer, execution };
  widgets.set(id, widget); hosts.set(host, id);
  host.append(view.element);
  if (field) host.append(field);
  const listen = { signal: listeners.signal, capture: true };
  document.addEventListener('reset', event => {
    if (event.target !== host.closest('form')) return;
    queueMicrotask(() => { if (!event.defaultPrevented && widgets.has(id)) reset(id); });
  }, listen);
  document.addEventListener('formdata', event => {
    if (!field || event.target !== field.form) return;
    const old = field.value;
    sync(widget);
    if (old === field.value) return;
    const data = (event as FormDataEvent).formData;
    const values = data.getAll(field.name);
    const index = values.findIndex(value => value === old);
    if (index < 0) return;
    values[index] = field.value;
    data.delete(field.name);
    for (const value of values) data.append(field.name, value);
  }, listen);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  if (execution === 'render') void controller.prepare();
  return id;
}
export function execute(target?: WidgetTarget, options?: RenderOptions): void {
  if (options) {
    if (target === undefined) throw new TypeError('Bkey: execute with options requires a container.');
    const id = render(target, { ...options, execution: 'execute' });
    void resolve(id).controller.execute();
  } else void resolve(target).controller.execute();
}
/** Empty string before success; otherwise the opaque response issued by the service. */
export function getResponse(target?: WidgetTarget): string { return sync(resolve(target)); }
export function isExpired(target?: WidgetTarget): boolean { const widget = resolve(target); sync(widget); return widget.controller.state === 'expired'; }
export function reset(target?: WidgetTarget): void {
  const widget = resolve(target); widget.controller.reset(); sync(widget);
  if (widget.execution === 'render') void widget.controller.prepare();
}
export function remove(target?: WidgetTarget): void {
  const widget = resolve(target);
  widgets.delete(widget.id); hosts.delete(widget.host);
  widget.observer.disconnect(); widget.listeners.abort(); widget.controller.dispose();
  widget.view.element.remove(); widget.field?.remove();
}
export function ready(callback: () => void): void {
  if (typeof document === 'undefined') throw new Error('Bkey: ready requires a browser.');
  if (typeof callback !== 'function') throw new TypeError('Bkey: ready requires a function.');
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => callback(), { once: true });
  else queueMicrotask(callback);
}
