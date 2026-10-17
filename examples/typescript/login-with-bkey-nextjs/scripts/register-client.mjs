// One-time self-serve registration (RFC 7591) — prints your .env values.
// Usage: APP_URL=http://localhost:3000 npm run register
// Override the environment with BKEY_ISSUER=https://staging-api.bkey.id if you
// are testing against staging with a staging-enrolled device.
import { randomUUID } from 'node:crypto';
import { registerClient } from '@bkey/login';

// Same env var the app reads (auth.ts), so the issuer you register against
// and the one the app authenticates against can never drift. ISSUER kept as
// a back-compat alias.
const issuer = process.env.BKEY_ISSUER ?? process.env.ISSUER ?? 'https://id.bkey.id';
const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
const reg = await registerClient({
  issuer,
  redirectUris: [`${appUrl}/api/auth/callback/bkey`],
  // Allowlisted so end_session can redirect back here after the spec-standard
  // logout hand-off. Local sign-out does not depend on this. Editable later
  // via the registration access token — it is not registration-only.
  postLogoutRedirectUris: [`${appUrl}/`],
  clientName: 'Login with bkey quickstart',
});
console.log('# add to .env.local (the secret is shown exactly once):');
console.log(`BKEY_ISSUER=${issuer}`);
console.log(`BKEY_CLIENT_ID=${reg.clientId}`);
console.log(`BKEY_CLIENT_SECRET=${reg.clientSecret}`);
console.log(`AUTH_SECRET=${randomUUID()}${randomUUID()}`);
