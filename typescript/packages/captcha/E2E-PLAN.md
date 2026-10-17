# Browser verification plan

The backend does not exist for this package yet. Tests use the real compiled browser
SDK, real QR encoder, and a demo adapter with controlled responses. They do
not establish that a person or passport is valid.

Failure cases to check:

- The compact state is not 300 x 65 px, or the expanded panel clips on a phone.
- Human, custom age, and age-of-majority requests use the wrong mode or text.
- A changed age operator or boundary is accepted for an earlier request.
- Invalid ranges or ages start a request.
- Age-of-majority accepts a website-selected age override.
- Mutating render options changes the active check.
- The QR image cannot be decoded or differs from the supplied request payload.
- A pending or scanned request is treated as approval.
- A result with the wrong request ID or mode grants UI success.
- Malformed data, unsafe links, network failures or unknown status grant success.
- An expired request remains usable, including after success.
- A late response changes the state after reset, cancellation, container removal or replacement.
- Repeated clicks start multiple requests, or polling overlaps.
- A hung create/status call never releases the UI.
- Keyboard users cannot start, cancel or retry, or focus is lost on collapse.
- Reduced motion is ignored; multiple widget instances interfere.
- A failed request leaves an old response available to a form.
- The published browser bundle imports Node-only modules or includes demo approval code.

Artifacts: Playwright HTML/JSON reports, screenshots, and traces for every test.
Run from typescript: pnpm --filter @bkey/captcha test:e2e.

## Public SDK

- A rendered widget does not forward its public sitekey and action to the adapter.
- Success callbacks, the response getter and the hidden form field disagree.
- Reset, expiry, denial, native form reset or removal leaves a usable field value.
- A form constructed just after expiry includes the stale response.
- Two widgets or forms share state, callbacks or fields by mistake.
- Removing a widget deletes unrelated content or accepts a late response.
- Invalid configuration or duplicate rendering leaves partial DOM content.
- The ESM and classic-script entry points expose different APIs.

## Backend-owned policy change

- Public render options or HTML attributes can override the sitekey check.
- Create or status sends browser-selected mode/age to the service.
- The widget assumes human verification before the service returns its policy.
- A service returns an absent or malformed check and the widget accepts it.
- A status response lowers the age from the created request and receives success.
- Reset retains the old rule after the service policy changes.
- Demo controls look like public SDK options rather than simulated portal settings.

Tests use simulated service policies keyed by sitekey. This verifies the SDK only,
not backend enforcement or resistance to a modified browser.

## Built-in backend connection

Before implementation: verify create/status wire fields, automatic Origin, no cookies,
poll token confined to its header, multiple widgets, reset/removal, malformed poll token,
mismatched status, network failure, and unsupported action/cData. Use Playwright route
fixtures for deterministic backend responses. These checks do not simulate face proof validity.
