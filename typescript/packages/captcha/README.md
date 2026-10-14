# @bkey/captcha

Bkey browser SDK for human and age checks. One API serves all check types.
The widget starts at 300 × 65 px, expands to show a QR code, and closes to a
checkmark after approval. It supports light, dark and automatic themes,
keyboard controls and reduced motion.

**Status:** The built-in connection supports the backend's human-check flow.
Age widgets remain available for custom transports and demos, but live age approval is not implemented.
The default demo simulates approval. Use `/demo/live.html` to connect to a real backend.

## Render a check

```html
<form id="signup">
  <div id="check"></div>
  <button type="submit">Continue</button>
</form>
```

```ts
import * as bkey from '@bkey/captcha';
// Uses https://api.bkey.id by default. No transport setup is needed.

const widgetId = bkey.render('#check', {
  sitekey: 'your-public-sitekey',
  callback(response) {
    // The same string is placed in the form's hidden bkey-response field.
    // Send it to your server for verification before granting access.
    console.log(response);
  },
  'error-callback': code => console.error(code),
  'expired-callback': () => console.log('Start again'),
});
```

For another environment, call `bkey.configure({ apiUrl: 'https://dev-api.bkey.id' })`
before rendering. The URL must be an HTTPS origin; HTTP is allowed for localhost.
The deployment must enable CAPTCHA requests and human issuance. The sitekey must
allow the browser hostname, including localhost explicitly for local development.
Never put a server secret in `sitekey` or browser code.

The SDK sends `POST /v1/captcha/requests` with `{ sitekey }`, uses the returned
`qrPayload` unchanged, and polls `GET /v1/captcha/requests/:id/status` with
`X-Bkey-Poll-Token`. Each widget keeps its polling credential only in memory and
clears it on reset, removal, expiry, failure, or completion. Requests omit cookies
and account credentials. Server expiry controls both request and result lifetime.

`action` and `cData` are currently rejected by the built-in connection because
the backend does not accept them. They remain available to custom transports.

Your server must POST `{ sitekey, clientId, clientSecret, response }` to
`/v1/captcha/siteverify`, require `success: true`, and check that `hostname`
matches the expected site. This consumes the result once. Keep `clientSecret`
on your server. A widget success callback alone must not grant access.

## Sitekey policy

The app owner configures the required check on the sitekey through authenticated
app management. These are stored policy values, **not** browser render options:

```ts
{ mode: 'human' }
{ mode: 'age', age: { operator: 'gte', value: 18 } }
{ mode: 'age', age: { operator: 'lte', value: 12 } }
{ mode: 'age', age: { operator: 'eq', value: 21 } }
{ mode: 'age', age: { operator: 'range', min: 12, max: 18 } }
{ mode: 'ageOfMajority' }
```

There is no default check. The backend must load the stored policy and copy it
into the request. The widget reads that policy from the create response and uses
it for labels and status matching. `mode`, `age`, and `check` render options are
rejected. They are not sent to the transport. Authenticated portal management and
backend request enforcement are not implemented by this UI package.

Ages are whole years from 0 to 150. Range endpoints and comparisons are inclusive.
Exact ages and ranges can disclose personal information. The phone approval flow
must explain the requested claim before the person approves it.

`ageOfMajority` asks for adult status without a site-selected country or age.
The planned service chooses the rule from the visitor's IP location and returns
only the result. This package does not locate the visitor or implement those rules.
An IP location does not establish residence. A future service connection must use
the visitor's IP, not the website server's outgoing IP.

## API

| Method | Behavior |
| --- | --- |
| `configure({ apiUrl })` or `configure({ transport })` | Sets the API origin or a custom service connection. Remove all widgets before replacing it. |
| `render(container, options)` | Creates a widget and returns its ID. |
| `execute(widget?)` | Starts an existing widget. |
| `execute(container, options)` | Creates and starts a widget in an empty container. |
| `getResponse(widget?)` | Returns the opaque response string, or `''` before success or after expiry. |
| `isExpired(widget?)` | Returns whether the current check or response has expired. |
| `reset(widget?)` | Clears the response and starts a new lifecycle. |
| `remove(widget?)` | Cancels work and removes the widget and its field. Keeps unrelated content. |
| `ready(callback)` | Calls the function when the document is ready. |

A widget target is its returned ID, a container selector, or the container element.
If omitted, the first active widget is used. Removed or unknown targets throw.
Containers must be attached to the document. Policy changes belong in authenticated
app management. Reset creates a new request and reads the current service policy;
it does not change an existing approval. The internal UI and controller are not public APIs.

| Option | Default | Supported values |
| --- | --- | --- |
| `sitekey` | Required | Public site key |
| `theme` | `auto` | `auto`, `light`, `dark` |
| `size` | `normal` | `normal`, `flexible` |
| `execution` | `render` | `render`, `execute` |
| `action` | None | 1–32 letters, digits, `_` or `-` |
| `cData` | None | 1–255 letters, digits, `_` or `-` |
| `callback` | None | `(response: string) => void` |
| `error-callback` | None | `(code: string) => void` |
| `expired-callback` | None | `() => void` |
| `denied-callback` | None | `() => void` |
| `response-field` | `true` | Adds a hidden form field |
| `response-field-name` | `bkey-response` | Custom field name |

`execution: 'render'` prepares the QR request when the widget is rendered. The
checkbox opens the QR panel and starts status polling. `execution: 'execute'`
waits for `execute()` before creating a request. It disables the checkbox until
then and shows the neutral label “Verify with bkey” until the service returns
the policy. Neither execution mode bypasses approval on the phone.

Reset, denial, errors and expiry clear the response field. Native form reset also
resets the widget unless the reset event is cancelled. The SDK removes expired
responses when a form builds its `FormData`. Server verification is still required.
The SDK does not block form submission or grant access.

## Classic script and HTML

Host the built `dist/api.js` file at a URL you control. There is no assumed CDN URL.
The bundle exposes `window.bkey`.

```html
<div class="bkey-captcha"
     data-sitekey="your-public-sitekey"
     data-callback="onApproved"></div>
<script>
  function onApproved(response) { console.log(response); }
  function initBkey() {
  }
</script>
<script src="/assets/bkey/api.js?onload=initBkey" async defer></script>
```

Define the service connection before the script loads. The onload function runs
before automatic rendering of `.bkey-captcha` containers. To render only through
JavaScript, add `&render=explicit` to the script URL and call `bkey.render` in the
onload function. `data-callback` values refer to named functions on `window`.
`data-mode`, `data-age`, and `data-check` are rejected.
Other supported attributes include `data-theme`, `data-size`, `data-execution`,
`data-action`, `data-cdata`, `data-response-field`, `data-response-field-name`,
`data-error-callback`, `data-expired-callback` and `data-denied-callback`.

## Service connection contract

The exported `Transport` type has two async methods. Both receive the public
`sitekey`, optional `action` and `cData`, and an `AbortSignal`. Neither accepts
a check, age rule, or location override. `action` and `cData` do not select policy.
`status` also receives `requestId`. Honor the signal to cancel network work.
Each call has a 15-second UI timeout, including adapters that ignore cancellation.

`create(input)` returns:

```json
{
  "requestId": "unique-request-id",
  "mode": "age",
  "age": { "operator": "gte", "value": 18 },
  "qrPayload": "bkey://captcha?id=unique-request-id",
  "expiresAt": "2027-01-01T12:02:00Z",
  "pollAfterMs": 1500
}
```

The QR link is an example of the contract, not a claim about a deployed app route.
Use the exact link supplied by the service. Only HTTPS and `bkey:` links are
accepted; the connection must also enforce trusted hosts. Poll intervals are
bounded to 1–10 seconds.

`status(input)` returns the same request ID and check conditions, plus `status`:
`pending`, `scanned`, `approved`, `denied` or `expired`. Approval must include:

```json
{
  "requestId": "unique-request-id",
  "mode": "age",
  "age": { "operator": "gte", "value": 18 },
  "status": "approved",
  "response": "opaque-service-issued-response",
  "responseExpiresAt": "2027-01-01T12:07:00Z"
}
```

Omit `age` for `human` and `ageOfMajority`. Expiry values are ISO 8601 UTC strings.
The response is not the request ID. Missing tokens, changed conditions, mismatched
request IDs and malformed responses do not produce success. Request and response
expiry are separate. Expired or late replies cannot restore a cleared response.

These checks protect UI state; they do not verify identity in the browser. The
future service must load policy from the sitekey, reject browser overrides, bind
the token to the sitekey, request and saved policy, enforce expiry and single use,
and provide server-side verification. The website server must verify the expected
sitekey and required policy, including after configuration changes. A token from
a weaker sitekey must not grant access. Never trust a browser
callback or a hidden field alone. The demo uses fake tokens and has no such service.

## Turnstile integration model

The main API follows the common Turnstile method names, token callback and hidden
field model. It is a single SDK, not a wrapper around a second public element API.
To migrate, change the loader/import and namespace to Bkey, use a Bkey site key,
connect the Bkey service, and replace server-side verification. If an existing
form needs the old field name, set `'response-field-name': 'cf-turnstile-response'`.
This changes only the form name; Bkey tokens are not Cloudflare tokens.

This is a supported subset, not full Cloudflare API or protocol compatibility.
Features such as compact/invisible widgets, appearance policies and automatic
retry settings are not supported. Unknown render options throw. The bundle does
not replace `window.turnstile`.

References: [client rendering](https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/),
[widget options](https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/widget-configurations/),
[server validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/).

## Local development and verification

From the `typescript` workspace:

```sh
pnpm install
pnpm --filter @bkey/captcha dev
pnpm --filter @bkey/captcha test:e2e
```

The demo opens at `http://127.0.0.1:4173`. E2E tests run the compiled SDK in desktop
Chromium and mobile WebKit. They exercise both package entry points, real QR
encoding, callbacks, forms, age conditions, cancellation, expiry and failures.
Repeatable artifacts are in `playwright-report/` and `test-results/`, including
screenshots, JSON results and browser traces. See `E2E-PLAN.md` for failure cases.
