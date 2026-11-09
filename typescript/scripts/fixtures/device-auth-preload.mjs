import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

// Capture the URL the CLI gives the browser without opening it.
childProcess.execFile = (_command, [url]) => console.log(`Browser URL: ${url}`);
syncBuiltinESMExports();

globalThis.fetch = async (url, options) => {
  const api = process.env.E2E_DEVICE_API;
  assert.equal(options.method, 'POST');
  if (url === `${api}/oauth/device/code`) {
    return Response.json({
      device_code: 'fixture-device-code',
      user_code: process.env.E2E_USER_CODE,
      verification_uri: 'https://approval.example/device',
      verification_uri_complete: process.env.E2E_VERIFICATION_URL,
      interval: 1,
      expires_in: 30,
    });
  }

  assert.equal(url, `${api}/oauth/token`);
  assert.equal(options.body.get('device_code'), 'fixture-device-code');
  assert.equal(options.body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
  console.log('Polled the fixture backend');
  return Response.json({ error: 'access_denied' }, { status: 400 });
};
