// copyright © 2025-2026 bkey inc. all rights reserved.

import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createClient, requireConfig, type RequireConfigOptions } from '../lib/config.js';
import {
  analytics,
  claimClient,
  createClient as registerOwnedClient,
  enablePersonas,
  getClient,
  listClients,
  revokeClient,
  rotateSecret,
  updateClient,
  uploadLogo,
  ClientApiError,
  type ClientApi,
  type ClientMetadata,
} from '../lib/oauth-clients.js';
import { storeOnPhone } from '../lib/vault-e2ee.js';

/**
 * `bkey clients` — manage "Login with bkey" OAuth clients from the terminal,
 * the headless twin of the bkey.id/developers dashboard. Runs as the
 * signed-in human (device-authorization token); an agent operating on the
 * developer's machine uses the same profile, the way `flyctl` does. The two
 * steps that mint a secret push it to the phone's vault by default so the
 * agent can use it later through `bkey proxy` / `bkey wrap` without the value
 * ever sitting in a chat transcript.
 */
export const clientsCommand = new Command('clients')
  .alias('client')
  .description('Manage your Login with bkey OAuth clients (headless developer dashboard)');

interface PrincipalOpts extends RequireConfigOptions {
  json?: boolean;
}

function principalOptions(cmd: Command): Command {
  return cmd
    .option('--profile <name>', 'Human profile to use (default: the active one)')
    .option('--json', 'Machine-readable output on stdout');
}

function clientApi(opts: RequireConfigOptions): ClientApi {
  // Always the human principal: client management is owner-scoped to the
  // signed-in developer, and the API rejects agent client_credentials tokens.
  const config = requireConfig({ ...opts, principal: 'human' });
  return { api: createClient({ ...opts, principal: 'human' }), baseUrl: config.apiUrl };
}

function fail(err: unknown): never {
  if (err instanceof ClientApiError) {
    const hint =
      err.code === 'permission_denied'
        ? ' (client management needs a signed-in human profile: run `bkey auth login`)'
        : err.code === 'unauthenticated'
          ? ' (run `bkey auth login`)'
          : '';
    console.error(`Failed: ${err.message} [${err.code}]${hint}`);
  } else {
    console.error(`Failed: ${(err as Error).message}`);
  }
  process.exit(1);
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fmtDate(iso: string | number | null | undefined): string {
  if (iso === null || iso === undefined) return '—';
  const d = typeof iso === 'number' ? new Date(iso * 1000) : new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toISOString().slice(0, 10);
}

function printMetadata(c: ClientMetadata): void {
  console.log(`Client ID:        ${c.client_id}`);
  console.log(`Name:             ${c.client_name ?? '—'}`);
  console.log(`Auth method:      ${c.token_endpoint_auth_method}`);
  console.log(`ID token alg:     ${c.id_token_signed_response_alg}`);
  console.log(`Grant types:      ${c.grant_types.join(', ')}`);
  console.log(`Scope:            ${c.scope ?? 'openid'}`);
  console.log(`Redirect URIs:    ${c.redirect_uris.join('\n                  ') || '—'}`);
  console.log(
    `Post-logout URIs: ${c.post_logout_redirect_uris.join('\n                  ') || '—'}`,
  );
  console.log(`Logo:             ${c.logo_uri ?? '—'}`);
  console.log(`Management URI:   ${c.registration_client_uri}`);
  if (c.client_id_issued_at) console.log(`Created:          ${fmtDate(c.client_id_issued_at)}`);
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string>((resolve) => rl.question(`${question} [y/N] `, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

/** Default vault item name for a client's secret: stable per client, unique per owner. */
function secretItemName(clientName: string | undefined, clientId: string): string {
  const base = (clientName ?? '').trim() || clientId;
  return `${base} · Login with bkey`;
}

async function pushSecretToPhone(
  api: ClientApi,
  input: { clientId: string; clientSecret: string; clientName?: string; itemName?: string },
): Promise<string> {
  const name = input.itemName ?? secretItemName(input.clientName, input.clientId);
  await storeOnPhone(api.api, {
    itemType: 'api_key',
    name,
    fields: {
      key: input.clientSecret,
      client_id: input.clientId,
      issuer: api.baseUrl,
    },
    description: `Client secret for Login with bkey client ${input.clientId}`,
    tags: ['login-with-bkey', 'oauth-client'],
    website: api.baseUrl,
  });
  return name;
}

// ─── list ────────────────────────────────────────────────────────────────

principalOptions(
  clientsCommand
    .command('list')
    .alias('ls')
    .description('List the OAuth clients you own')
    .option('--all', 'Include revoked clients'),
).action(async (opts: PrincipalOpts & { all?: boolean }) => {
  try {
    const clients = await listClients(clientApi(opts));
    const shown = opts.all ? clients : clients.filter((c) => !c.revokedAt);
    if (opts.json) return printJson(shown);
    if (shown.length === 0) {
      console.log(
        clients.length === 0
          ? 'No OAuth clients yet. Create one with `bkey clients create --name "My App" --redirect-uri https://...`.'
          : 'No active OAuth clients (pass --all to include revoked ones).',
      );
      return;
    }
    const idWidth = Math.max(...shown.map((c) => c.clientId.length), 9);
    const nameWidth = Math.min(Math.max(...shown.map((c) => c.name.length), 4), 40);
    console.log(
      `${'CLIENT ID'.padEnd(idWidth)}  ${'NAME'.padEnd(nameWidth)}  ${'TYPE'.padEnd(12)}  ${'PERSONAS'.padEnd(8)}  CREATED     STATUS`,
    );
    for (const c of shown) {
      const name = c.name.length > nameWidth ? `${c.name.slice(0, nameWidth - 1)}…` : c.name;
      console.log(
        `${c.clientId.padEnd(idWidth)}  ${name.padEnd(nameWidth)}  ${c.clientType.padEnd(12)}  ${(c.personaSupport ? 'on' : 'off').padEnd(8)}  ${fmtDate(c.createdAt)}  ${c.revokedAt ? `revoked ${fmtDate(c.revokedAt)}` : 'active'}`,
      );
    }
  } catch (err) {
    fail(err);
  }
});

// ─── get ─────────────────────────────────────────────────────────────────

principalOptions(
  clientsCommand.command('get <client_id>').description('Show one client\'s registered metadata'),
).action(async (clientId: string, opts: PrincipalOpts) => {
  try {
    const c = await getClient(clientApi(opts), clientId);
    if (opts.json) return printJson(c);
    printMetadata(c);
  } catch (err) {
    fail(err);
  }
});

// ─── create ──────────────────────────────────────────────────────────────

principalOptions(
  clientsCommand
    .command('create')
    .description('Register a new Login with bkey client owned by you; the secret is pushed to your phone\'s vault')
    .requiredOption('--name <name>', 'Application name shown on the consent screen')
    .requiredOption(
      '--redirect-uri <uri...>',
      'Allowed redirect URI(s), e.g. https://yourapp.com/api/auth/callback/bkey',
    )
    .option('--post-logout-redirect-uri <uri...>', 'Allowed post-logout redirect URI(s)')
    .option('--public', 'Public (PKCE-only) client with no secret — for SPAs / native apps')
    .option('--id-token-alg <alg>', 'id_token signing algorithm (default: EdDSA)')
    .option('--no-vault', 'Do not push the client secret to your phone\'s vault')
    .option('--vault-name <name>', 'Vault item name for the secret (default: "<name> · Login with bkey")'),
).action(
  async (
    opts: PrincipalOpts & {
      name: string;
      redirectUri: string[];
      postLogoutRedirectUri?: string[];
      public?: boolean;
      idTokenAlg?: string;
      vault: boolean;
      vaultName?: string;
    },
  ) => {
    const api = clientApi(opts);
    let created;
    try {
      created = await registerOwnedClient(api, {
        clientName: opts.name,
        redirectUris: opts.redirectUri,
        postLogoutRedirectUris: opts.postLogoutRedirectUri,
        tokenEndpointAuthMethod: opts.public ? 'none' : 'client_secret_post',
        idTokenSignedResponseAlg: opts.idTokenAlg,
      });
    } catch (err) {
      fail(err);
    }

    let vaultItem: string | null = null;
    let vaultError: string | null = null;
    if (created.client_secret && opts.vault) {
      process.stderr.write(
        `Created ${created.client_id}. Sending its secret to your phone's vault — approve on your phone...\n`,
      );
      try {
        vaultItem = await pushSecretToPhone(api, {
          clientId: created.client_id,
          clientSecret: created.client_secret,
          clientName: created.client_name,
          itemName: opts.vaultName,
        });
      } catch (err) {
        vaultError = (err as Error).message;
        process.stderr.write(
          `Warning: the secret was NOT stored in your vault (${vaultError}). It is printed below exactly once — store it yourself.\n`,
        );
      }
    }

    if (opts.json) {
      return printJson({ ...created, vault_item: vaultItem, vault_error: vaultError });
    }
    console.log(`Created Login with bkey client.\n`);
    printMetadata(created);
    if (created.client_secret) {
      console.log(`\nClient secret (shown once):\n  ${created.client_secret}`);
      if (vaultItem) {
        console.log(`\nStored in your vault as "${vaultItem}". Use it without exposing it:`);
        console.log(
          `  bkey wrap --env BKEY_CLIENT_SECRET={vault:${vaultItem}} -- <your command>`,
        );
      } else if (!opts.vault) {
        console.log(`\nNot stored in your vault (--no-vault). Store it like a password.`);
      }
    } else {
      console.log(`\nPublic client (PKCE only) — no secret.`);
    }
    console.log(`\nQuickstart (Auth.js):
  import { BkeyProvider } from '@bkey/login/authjs';
  providers: [BkeyProvider({ clientId: '${created.client_id}'${created.client_secret ? ", clientSecret: process.env.BKEY_CLIENT_SECRET!" : ''}${api.baseUrl !== 'https://api.bkey.id' && api.baseUrl !== 'https://id.bkey.id' ? `, issuer: '${api.baseUrl}'` : ''} })]`);
  },
);

// ─── update ──────────────────────────────────────────────────────────────

principalOptions(
  clientsCommand
    .command('update <client_id>')
    .description('Update a client\'s name, redirect URIs, post-logout URIs, or id_token algorithm')
    .option('--name <name>', 'New application name')
    .option('--redirect-uri <uri...>', 'Replace the redirect URI list')
    .option('--post-logout-redirect-uri <uri...>', 'Replace the post-logout redirect URI list')
    .option('--clear-post-logout-redirect-uris', 'Remove every post-logout redirect URI')
    .option('--id-token-alg <alg>', 'id_token signing algorithm'),
).action(
  async (
    clientId: string,
    opts: PrincipalOpts & {
      name?: string;
      redirectUri?: string[];
      postLogoutRedirectUri?: string[];
      clearPostLogoutRedirectUris?: boolean;
      idTokenAlg?: string;
    },
  ) => {
    const postLogout = opts.clearPostLogoutRedirectUris ? [] : opts.postLogoutRedirectUri;
    if (
      opts.name === undefined &&
      opts.redirectUri === undefined &&
      postLogout === undefined &&
      opts.idTokenAlg === undefined
    ) {
      console.error('Nothing to update — pass at least one of --name, --redirect-uri, --post-logout-redirect-uri, --id-token-alg.');
      process.exit(1);
    }
    try {
      const c = await updateClient(clientApi(opts), clientId, {
        clientName: opts.name,
        redirectUris: opts.redirectUri,
        postLogoutRedirectUris: postLogout,
        idTokenSignedResponseAlg: opts.idTokenAlg,
      });
      if (opts.json) return printJson(c);
      console.log('Updated.\n');
      printMetadata(c);
    } catch (err) {
      fail(err);
    }
  },
);

// ─── rotate-secret ───────────────────────────────────────────────────────

principalOptions(
  clientsCommand
    .command('rotate-secret <client_id>')
    .description('Issue a new client secret (returned once); the old one keeps working for --grace-hours')
    .option('--grace-hours <n>', 'Hours the old secret stays valid (0 = revoke it now)', '24')
    .option('--no-vault', 'Do not push the new secret to your phone\'s vault')
    .option('--vault-name <name>', 'Vault item name for the new secret'),
).action(
  async (
    clientId: string,
    opts: PrincipalOpts & { graceHours: string; vault: boolean; vaultName?: string },
  ) => {
    const grace = Number(opts.graceHours);
    if (!Number.isInteger(grace) || grace < 0) {
      console.error('--grace-hours must be a non-negative integer.');
      process.exit(1);
    }
    const api = clientApi(opts);
    let rotated;
    try {
      rotated = await rotateSecret(api, clientId, grace);
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        console.error(
          'Failed: the request timed out before the new secret arrived. The rotation MAY have completed on the server — check whether your old secret still works before rotating again.',
        );
        process.exit(1);
      }
      fail(err);
    }

    let vaultItem: string | null = null;
    let vaultError: string | null = null;
    if (opts.vault) {
      process.stderr.write(`Rotated. Sending the new secret to your phone's vault — approve on your phone...\n`);
      try {
        vaultItem = await pushSecretToPhone(api, {
          clientId: rotated.client_id,
          clientSecret: rotated.client_secret,
          itemName:
            opts.vaultName ??
            `${rotated.client_id} · Login with bkey (rotated ${new Date().toISOString().slice(0, 10)})`,
        });
      } catch (err) {
        vaultError = (err as Error).message;
        process.stderr.write(
          `Warning: the new secret was NOT stored in your vault (${vaultError}). It is printed below exactly once.\n`,
        );
      }
    }

    if (opts.json) return printJson({ ...rotated, vault_item: vaultItem, vault_error: vaultError });
    console.log(`New client secret for ${rotated.client_id} (shown once):\n  ${rotated.client_secret}`);
    console.log(
      rotated.old_secret_expires_at
        ? `The previous secret keeps working until ${rotated.old_secret_expires_at} — deploy this one before then.`
        : 'The previous secret was revoked immediately.',
    );
    if (vaultItem) console.log(`Stored in your vault as "${vaultItem}".`);
  },
);

// ─── revoke ──────────────────────────────────────────────────────────────

principalOptions(
  clientsCommand
    .command('revoke <client_id>')
    .alias('delete')
    .description('Revoke a client: new sign-ins stop immediately, existing tokens expire within minutes')
    .option('-y, --yes', 'Skip the confirmation prompt'),
).action(async (clientId: string, opts: PrincipalOpts & { yes?: boolean }) => {
  if (!opts.yes && !(await confirm(`Revoke ${clientId}? This cannot be undone from the CLI.`))) {
    console.error('Aborted (pass --yes to skip the prompt).');
    process.exit(1);
  }
  try {
    await revokeClient(clientApi(opts), clientId);
    if (opts.json) return printJson({ client_id: clientId, revoked: true });
    console.log(`Revoked ${clientId}.`);
  } catch (err) {
    fail(err);
  }
});

// ─── analytics ───────────────────────────────────────────────────────────

principalOptions(
  clientsCommand
    .command('analytics <client_id>')
    .alias('stats')
    .description('Login funnel for a client: started vs completed sign-ins over 7 and 30 days'),
).action(async (clientId: string, opts: PrincipalOpts) => {
  try {
    const res = await analytics(clientApi(opts), clientId);
    if (opts.json) return printJson(res);
    const f = res.funnel;
    const rate = (started: number, completed: number) =>
      started > 0 ? `${Math.round((completed / started) * 100)}%` : '—';
    console.log(`Login funnel for ${res.client_id}\n`);
    console.log('WINDOW   STARTED  COMPLETED  RATE');
    console.log(`7 days   ${String(f.started_7d).padEnd(7)}  ${String(f.completed_7d).padEnd(9)}  ${rate(f.started_7d, f.completed_7d)}`);
    console.log(`30 days  ${String(f.started_30d).padEnd(7)}  ${String(f.completed_30d).padEnd(9)}  ${rate(f.started_30d, f.completed_30d)}`);
  } catch (err) {
    fail(err);
  }
});

// ─── enable-personas ─────────────────────────────────────────────────────

principalOptions(
  clientsCommand
    .command('enable-personas <client_id>')
    .description('Let users sign in to this client with a per-site persona (PERMANENT for the client)')
    .option('-y, --yes', 'Skip the confirmation prompt'),
).action(async (clientId: string, opts: PrincipalOpts & { yes?: boolean }) => {
  if (
    !opts.yes &&
    !(await confirm(
      `Enable personas on ${clientId}? Users get a stable per-app ID that cannot be linked across sites. This is permanent — disabling later needs bkey support.`,
    ))
  ) {
    console.error('Aborted (pass --yes to skip the prompt).');
    process.exit(1);
  }
  try {
    const res = await enablePersonas(clientApi(opts), clientId);
    if (opts.json) return printJson(res);
    console.log(`Personas enabled on ${res.client_id}.`);
  } catch (err) {
    fail(err);
  }
});

// ─── logo ────────────────────────────────────────────────────────────────

principalOptions(
  clientsCommand
    .command('logo <client_id> <png_file>')
    .description('Upload or replace the client logo (PNG, up to 256 KiB)'),
).action(async (clientId: string, pngFile: string, opts: PrincipalOpts) => {
  let png: Buffer;
  try {
    png = readFileSync(pngFile);
  } catch (err) {
    console.error(`Cannot read ${pngFile}: ${(err as Error).message}`);
    process.exit(1);
  }
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (png.length < 8 || !png.subarray(0, 8).equals(PNG_MAGIC)) {
    console.error('The logo must be a PNG file.');
    process.exit(1);
  }
  if (png.length > 256 * 1024) {
    console.error(`The logo must be 256 KiB or smaller (got ${Math.ceil(png.length / 1024)} KiB).`);
    process.exit(1);
  }
  try {
    const res = await uploadLogo(clientApi(opts), clientId, new Uint8Array(png));
    if (opts.json) return printJson(res);
    console.log(`Logo uploaded: ${res.logo_uri}`);
  } catch (err) {
    fail(err);
  }
});

// ─── claim ───────────────────────────────────────────────────────────────

principalOptions(
  clientsCommand
    .command('claim <client_id>')
    .description('Claim a client that was registered anonymously (RFC 7591) so it shows up under your account')
    .requiredOption(
      '--registration-access-token <token>',
      'The one-time registration access token returned at registration',
    ),
).action(
  async (clientId: string, opts: PrincipalOpts & { registrationAccessToken: string }) => {
    try {
      const c = await claimClient(clientApi(opts), clientId, opts.registrationAccessToken);
      if (opts.json) return printJson(c);
      console.log(`Claimed ${c.client_id}. It now appears in \`bkey clients list\`.\n`);
      printMetadata(c);
    } catch (err) {
      fail(err);
    }
  },
);
