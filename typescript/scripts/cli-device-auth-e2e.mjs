import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import jsQR from 'jsqr';

const cli = fileURLToPath(new URL('../packages/cli/dist/index.js', import.meta.url));
const preload = fileURLToPath(new URL('./fixtures/device-auth-preload.mjs', import.meta.url));
const userCode = 'AB+C &?=#é';
const verificationUrl = 'https://approval.example/device?user_code=' + encodeURIComponent(userCode);

// The terminal renderer packs two module rows into each line of block characters.
function decodeTerminalQr(output) {
  const rows = output.split('\n').filter((line) => /^[ ▄▀█]+$/.test(line) && /[▄▀█]/.test(line));
  if (!rows.length) return null;

  const scale = 4;
  const border = 4;
  const width = (rows[0].length + border * 2) * scale;
  const height = (rows.length * 2 + border * 2) * scale;
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const [row, line] of rows.entries()) {
    assert.equal(line.length, rows[0].length);
    for (const [column, cell] of [...line].entries()) {
      for (const [half, dark] of [cell === '█' || cell === '▀', cell === '█' || cell === '▄'].entries()) {
        if (!dark) continue;
        const top = (row * 2 + half + border) * scale;
        const left = (column + border) * scale;
        for (let y = top; y < top + scale; y++) {
          for (let x = left; x < left + scale; x++) {
            const offset = (y * width + x) * 4;
            pixels.fill(0, offset, offset + 3);
          }
        }
      }
    }
  }
  const qr = jsQR(pixels, width, height, { inversionAttempts: 'dontInvert' });
  assert.ok(qr, 'The printed QR must decode');
  return qr.data;
}

const scenarios = [
  { api: 'https://api.bkey.id', scheme: 'bkeyid' },
  { api: 'https://staging-api.bkey.id', scheme: 'bkeyid-beta', fromEnv: true },
  { api: 'https://dev-api.bkey.id', scheme: 'bkeyid-dev' },
  { api: 'https://self-hosted.example' },
  { api: 'https://api.bkey.id.example' },
  { api: 'https://api.bkey.id:8443' },
  { api: 'http://127.0.0.1:3000', loopback: true },
];

const results = [];
for (const { api, scheme, fromEnv, loopback } of scenarios) {
  const args = ['--import', preload, cli, 'auth', 'login'];
  if (!fromEnv) args.push('--base-url', api);
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      BKEY_API_URL: fromEnv ? api : 'https://wrong.example',
      BKEY_BASE_URL: '',
      E2E_DEVICE_API: api,
      E2E_USER_CODE: userCode,
      E2E_VERIFICATION_URL: verificationUrl,
    },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Device authorization was denied by the user/);
  assert.ok(result.stdout.includes('Polled the fixture backend'));
  assert.ok(result.stdout.includes(`Your code:  ${userCode}`));

  const browserUrl = result.stdout.match(/^Browser URL: (.+)$/m)?.[1];
  assert.ok(browserUrl);
  if (loopback) {
    assert.equal(new URL(browserUrl).origin + new URL(browserUrl).pathname, `${api}/device`);
  } else {
    assert.equal(browserUrl, verificationUrl);
  }
  assert.equal(new URL(browserUrl).searchParams.get('user_code'), userCode);

  const decodedQr = decodeTerminalQr(result.stdout);
  if (scheme) {
    assert.ok(decodedQr, `${api} should print an app QR`);
    const link = new URL(decodedQr);
    assert.equal(link.protocol, `${scheme}:`, api);
    assert.equal(link.hostname, 'device-approve', api);
    assert.deepEqual([...link.searchParams], [['user_code', userCode]], api);
  } else {
    assert.equal(decodedQr, null, `${api} must not print an app QR`);
  }
  results.push({ api, decodedQr, browserUrl, result: 'passed' });
}

console.log(JSON.stringify(results, null, 2));
