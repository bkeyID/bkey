// One-time self-serve registration (RFC 7591) — prints your .env values.
// Usage: ISSUER=https://staging-api.bkey.id APP_URL=http://localhost:3000 npm run register
import { registerClient } from '@bkey/login';

const issuer = process.env.ISSUER ?? 'https://auth.bkey.id';
const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
const reg = await registerClient({
  issuer,
  redirectUris: [`${appUrl}/api/auth/callback/bkey`],
  clientName: 'Login with bkey quickstart',
});
console.log('# add to .env.local (the secret is shown exactly once):');
console.log(`BKEY_CLIENT_ID=${reg.clientId}`);
console.log(`BKEY_CLIENT_SECRET=${reg.clientSecret}`);
console.log(`AUTH_SECRET=${crypto.randomUUID()}${crypto.randomUUID()}`);
