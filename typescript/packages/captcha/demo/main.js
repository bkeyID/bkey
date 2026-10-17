import * as bkey from '/dist/index.js';
const requests = new Map();
// Simulated service configuration, not browser SDK options.
const policies = new Map([['demo-human-sitekey', { mode: 'human' }], ['demo-age-sitekey', { mode: 'age', age: { operator: 'gte', value: 18 } }]]);
const inputs = [];
const settings = { scenario: 'normal', lifetime: 120000, responseLifetime: 300000, createDelay: 450, statusDelay: 120 };
let calls = { create: 0, status: 0, active: 0, maxActive: 0 };
let theme = 'light';
const ids = {};
const events = [];
const messages = { success: 'Demo approval received', expired: 'Expired. Try a fresh request.', denied: 'Declined. You can try again.', error: 'Could not verify. Try again.' };
function notify(kind, type, detail) {
  events.push({ kind, type, detail });
  const output = document.querySelector(`#${kind}-result`);
  if (output) { output.textContent = messages[type]; output.classList.toggle('success', type === 'success'); }
}
const delay = (ms, signal) => new Promise((resolve, reject) => {
  const cancel = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, ms);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
});
const transport = {
  async create(input) {
    const { signal, sitekey, action, cData } = input;
    inputs.push({ operation: 'create', ...input, signal: undefined });
    const policy = policies.get(sitekey);
    if (!policy) throw new Error('Unknown demo sitekey');
    const { mode, age } = structuredClone(policy);
    calls.create++;
    const scenario = settings.scenario;
    await delay(settings.createDelay, scenario === 'late' ? undefined : signal);
    if (scenario === 'error') throw new Error('Demo connection error');
    if (scenario === 'hung-create') return new Promise(() => {});
    const requestId = `demo-${crypto.randomUUID()}`;
    const request = { requestId, mode, ...(age ? { age: structuredClone(age) } : {}), qrPayload: `bkey://captcha?request_id=${requestId}`, expiresAt: new Date(Date.now() + settings.lifetime).toISOString(), pollAfterMs: 1000 };
    requests.set(requestId, { ...structuredClone(request), sitekey, action, cData, started: 0, status: 'pending', response: `demo-response-${crypto.randomUUID()}` });
    if (scenario === 'bad-url') request.qrPayload = 'javascript:alert(1)';
    if (scenario === 'bad-create-mode') request.mode = 'unknown';
    if (scenario === 'bad-create-age' && mode === 'age') request.age = { operator: 'gte', value: -1 };
    return request;
  },
  async status(input) {
    inputs.push({ operation: 'status', ...input, signal: undefined });
    const { requestId, signal } = input;
    calls.status++; calls.active++; calls.maxActive = Math.max(calls.maxActive, calls.active);
    const scenario = settings.scenario;
    try {
      await delay(settings.statusDelay, scenario === 'late' ? undefined : signal);
      if (scenario === 'hung-status') return new Promise(() => {});
      const entry = requests.get(requestId);
      if (!entry) throw new Error('Unknown demo request');
      if (!entry.started) entry.started = Date.now();
      let status = entry.status;
      const elapsed = Date.now() - entry.started;
      if (document.querySelector('#auto').checked && status === 'pending') {
        if (elapsed > 4000) status = document.querySelector('#outcome').value;
        else if (elapsed > 1000) status = 'scanned';
      }
      if (status === 'error') throw new Error('Demo connection error');
      const result = {
        requestId: scenario === 'bad-id' ? 'another-request' : requestId,
        mode: scenario === 'bad-status-mode' ? (entry.mode === 'human' ? 'ageOfMajority' : 'human') : entry.mode,
        ...(entry.age ? { age: structuredClone(entry.age) } : {}),
        status: scenario === 'unknown' ? 'success' : status,
      };
      if (scenario === 'bad-status-age' && entry.age) result.age = { operator: 'gte', value: 1 };
      if (status === 'approved' && scenario !== 'missing-response') {
        result.response = entry.response;
        result.responseExpiresAt = new Date(Date.now() + settings.responseLifetime).toISOString();
      }
      return result;
    } finally { calls.active--; }
  },
};
bkey.configure({ transport });
function ageCheck() {
  const operator = document.querySelector('#age-operator').value;
  if (operator === 'ageOfMajority') return { mode: 'ageOfMajority' };
  const number = id => document.getElementById(id).value === '' ? null : Number(document.getElementById(id).value);
  return { mode: 'age', age: operator === 'range'
    ? { operator, min: number('age-value'), max: number('age-max') }
    : { operator, value: number('age-value') } };
}
function mount(kind, overrides = {}) {
  if (ids[kind]) { bkey.remove(ids[kind]); delete ids[kind]; }
  const output = document.querySelector(`#${kind}-result`);
  if (output) { output.textContent = 'Ready when you are'; output.classList.remove('success'); }
  try {
    ids[kind] = bkey.render(`#${kind}`, {
      sitekey: kind === 'age' ? 'demo-age-sitekey' : 'demo-human-sitekey', action: 'preview', theme,
      callback: response => notify(kind, 'success', response),
      'error-callback': code => notify(kind, 'error', code),
      'expired-callback': () => notify(kind, 'expired'),
      'denied-callback': () => notify(kind, 'denied'),
      ...overrides,
    });
  } catch (error) { if (output) output.textContent = error.message; else throw error; }
  return ids[kind];
}
mount('human'); mount('age');
document.querySelectorAll('[data-reset]').forEach(button => button.addEventListener('click', () => {
  const kind = button.dataset.reset;
  if (ids[kind]) bkey.reset(ids[kind]); else mount(kind);
  document.querySelector(`#${kind}-result`).textContent = 'Ready when you are';
}));
document.querySelectorAll('[data-theme]').forEach(button => button.addEventListener('click', () => {
  theme = button.dataset.theme; document.body.dataset.theme = theme;
  mount('human'); mount('age');
  document.querySelectorAll('[data-theme]').forEach(item => { item.classList.toggle('selected', item === button); item.setAttribute('aria-pressed', String(item === button)); });
}));
document.querySelector('#simulate').addEventListener('click', () => { for (const entry of requests.values()) entry.status = document.querySelector('#outcome').value; });
function updateAgeCheck() {
  const operator = document.querySelector('#age-operator').value;
  const range = operator === 'range', majority = operator === 'ageOfMajority';
  document.querySelector('#age-value-field').hidden = majority;
  document.querySelector('#age-max-field').hidden = !range;
  document.querySelector('#age-value-label').textContent = range ? 'From' : 'Age';
  document.querySelector('#age-mode-tag').textContent = majority ? 'ADULT' : 'AGE';
  document.querySelector('#age-policy-note').textContent = majority
    ? 'Bkey selects the rule from IP location. Location detection is not connected in this preview.'
    : 'These controls simulate portal settings. Websites cannot set the age through the SDK.';
  policies.set('demo-age-sitekey', ageCheck());
  mount('age');
}
for (const id of ['age-operator', 'age-value', 'age-max']) document.getElementById(id).addEventListener('input', updateAgeCheck);
// Demo controls are excluded from the browser SDK build.
window.demo = {
  sdk: bkey, ids, transport, settings, requests, events, mount, policies, inputs,
  get calls() { return { ...calls }; },
  setStatus(status, mode) { for (const entry of requests.values()) if (!mode || entry.mode === mode) entry.status = status; },
  clear() {
    for (const kind of Object.keys(ids)) { bkey.remove(ids[kind]); delete ids[kind]; }
    requests.clear(); inputs.length = 0; events.length = 0; calls = { create: 0, status: 0, active: 0, maxActive: 0 };
  },
};
