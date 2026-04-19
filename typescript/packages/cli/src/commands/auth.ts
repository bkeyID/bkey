// copyright © 2025-2026 bkey inc. all rights reserved.

import { Command } from 'commander';
import {
  saveHumanProfile,
  saveAgentProfile,
  deleteHumanProfile,
  deleteAgentProfile,
  loadActiveHumanProfile,
  getDefaultProfileName,
  agentProfileExists,
  listProfiles,
  resolveApiUrl,
  resolveProfileName,
  slugifyProfileName,
  removeLegacyFiles,
  wireHumanProfilePersistence,
} from '../lib/config.js';
import { getProfile } from '../lib/profiles.js';
import { CLI_CLIENT_ID } from '../lib/constants.js';
import { pollDeviceAuth } from '../lib/device-auth-poll.js';

export const authCommand = new Command('auth')
  .description('Manage BKey CLI authentication');

// ─── bkey auth login ───────────────────────────────────────────────

authCommand
  .command('login')
  .description('Authenticate a human principal via device authorization flow')
  .option('--base-url <url>', 'BKey base URL (default: $BKEY_BASE_URL or https://api.bkey.id)')
  .option('--profile <name>', 'Profile identifier to save as (default: "default")', 'default')
  .action(async (opts: { baseUrl?: string; profile: string }) => {
    const apiUrl = (opts.baseUrl || process.env.BKEY_BASE_URL || 'https://api.bkey.id').replace(/\/$/, '');
    const profileName = opts.profile || 'default';

    console.log(`Starting device authorization flow (profile: ${profileName})...\n`);

    let initJson: Record<string, unknown>;
    try {
      const initRes = await fetch(`${apiUrl}/oauth/device/code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: CLI_CLIENT_ID,
          device_name: (await import('node:os')).hostname(),
        }),
        signal: AbortSignal.timeout(15_000),
      });

      initJson = (await initRes.json()) as Record<string, unknown>;
      if (!initRes.ok) {
        const errDetail = initJson.error_description
          ?? (typeof initJson.error === 'object' ? (initJson.error as Record<string, unknown>)?.message : initJson.error)
          ?? `HTTP ${initRes.status}`;
        console.error(`Failed to start device auth: ${errDetail}`);
        process.exit(1);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Failed to connect to ${apiUrl}: ${msg}`);
      console.error('Is the backend running? Check --base-url or $BKEY_BASE_URL.');
      process.exit(1);
    }

    const userCode = initJson.user_code as string;
    const hasExplicitBaseUrl = opts.baseUrl || process.env.BKEY_BASE_URL;
    const verificationUri = hasExplicitBaseUrl
      ? `${apiUrl}/device`
      : initJson.verification_uri as string;
    const verificationUriComplete = hasExplicitBaseUrl
      ? `${apiUrl}/device?user_code=${userCode}`
      : (initJson.verification_uri_complete as string) ?? `${verificationUri}?user_code=${userCode}`;
    const deviceCode = initJson.device_code as string;
    const interval = initJson.interval as number;
    const expiresIn = initJson.expires_in as number;

    console.log('┌─────────────────────────────────────────┐');
    console.log(`│  Your code:  ${userCode}                │`);
    console.log('├─────────────────────────────────────────┤');
    console.log(`│  Open: ${verificationUriComplete}`);
    console.log(`│  Or approve in the BKey app on your phone`);
    console.log('└─────────────────────────────────────────┘');

    try {
      const QRCode = await import('qrcode');
      const deepLink = `bkeyid://device-approve?user_code=${userCode}`;
      const qrText = await QRCode.toString(deepLink, {
        type: 'utf8',
        errorCorrectionLevel: 'L',
        margin: 1,
      });
      console.log('\n' + qrText);
      console.log('  Scan to open on your phone\n');
    } catch {
      // QR generation is non-critical; skip silently
    }

    try {
      if (!/^https?:\/\//i.test(verificationUriComplete)) {
        throw new Error('Server returned non-HTTP verification URI');
      }
      const { execFile } = await import('node:child_process');
      const openCmd = process.platform === 'darwin' ? 'open'
        : process.platform === 'win32' ? 'start'
        : 'xdg-open';
      execFile(openCmd, [verificationUriComplete]);
      console.log(`\nOpened browser. Waiting for approval (expires in ${expiresIn}s)...`);
    } catch {
      console.log(`\nWaiting for approval (expires in ${expiresIn}s)...`);
    }

    try {
      const tokens = await pollDeviceAuth(apiUrl, deviceCode, CLI_CLIENT_ID, interval, undefined, expiresIn);

      let did = '';
      try {
        const payload = JSON.parse(
          Buffer.from(tokens.access_token.split('.')[1]!, 'base64url').toString(),
        );
        did = payload.sub ?? '';
      } catch {
        // Non-critical — DID is for display only
      }

      saveHumanProfile(profileName, {
        apiUrl,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        tokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
        did,
      });

      console.log(`\nAuthenticated — saved as human profile "${profileName}".`);
      if (did) console.log(`DID: ${did}`);
      console.log(`Token expires: ${new Date(Date.now() + tokens.expires_in * 1000).toLocaleString()}`);
    } catch (err) {
      console.error(`\n${(err as Error).message}`);
      process.exit(1);
    }
  });

// ─── bkey auth setup-agent ─────────────────────────────────────────

authCommand
  .command('setup-agent')
  .description('Create an OAuth client for agent/CI use (requires prior human login)')
  .option('--base-url <url>', "BKey base URL (overrides the active human profile's API URL)")
  .option('--name <name>', 'Display name shown in the phone approval dialog', 'My Agent')
  .option(
    '--profile <name>',
    'Profile identifier to save as (default: slug of --name, or "default")',
  )
  .option(
    '--scopes <scopes>',
    'Comma-separated scopes (must be a subset of your own grants). Default is minimal — add `vault:*`, `signing:*`, `payment:*` explicitly if the agent needs them.',
    'approve:action',
  )
  .option('--json', 'Output credentials as JSON (for scripting)')
  .option('--save', 'Save credentials to ~/.bkey/profiles.json for persistent agent mode')
  .option('--overwrite', 'Overwrite an existing agent profile with the same name')
  .action(async (opts: {
    baseUrl?: string;
    name: string;
    profile?: string;
    scopes: string;
    json?: boolean;
    save?: boolean;
    overwrite?: boolean;
  }) => {
    // Resolve the on-disk identifier. Preference: --profile > slug(--name) > 'default'.
    const profileName =
      opts.profile?.trim()
      || (opts.name && opts.name !== 'My Agent' ? slugifyProfileName(opts.name) : 'default');

    if (opts.save && agentProfileExists(profileName) && !opts.overwrite) {
      console.error(`An agent profile named "${profileName}" already exists.`);
      console.error('Pass --profile <unique-name> or add --overwrite to replace it.');
      process.exit(1);
    }

    const humanProfile = loadActiveHumanProfile();
    if (!humanProfile?.accessToken) {
      console.error('You must be logged in as a human first. Run: bkey auth login');
      console.error('(Agent env vars cannot be used to create new agent clients.)');
      process.exit(1);
    }

    const apiUrl = (opts.baseUrl ?? humanProfile.apiUrl).replace(/\/$/, '');
    const humanProfileName = getDefaultProfileName('human')!; // asserted above

    const { BKey } = await import('@bkey/sdk');
    const api = new BKey({
      apiUrl,
      accessToken: humanProfile.accessToken,
      refreshToken: humanProfile.refreshToken,
      tokenExpiresAt: humanProfile.tokenExpiresAt,
      clientId: CLI_CLIENT_ID,
    });
    // Persist rotated tokens back to disk so a retried setup-agent invocation
    // doesn't fail with "refresh token already used".
    wireHumanProfilePersistence(api, humanProfileName);
    const token = await api.getValidToken();

    const scopes = opts.scopes.split(',').map((s) => s.trim());

    const initiateRes = await fetch(`${apiUrl}/oauth/clients`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: opts.name,
        allowedScopes: scopes,
        grantTypes: ['client_credentials'],
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const initiateJson = (await initiateRes.json()) as Record<string, unknown>;
    if (!initiateRes.ok) {
      const err = (initiateJson.error as Record<string, unknown>)?.message ?? initiateJson.error_description ?? initiateRes.status;
      console.error(`Failed to initiate agent creation: ${err}`);
      process.exit(1);
    }

    let json: Record<string, unknown>;

    if (initiateJson.clientId && initiateJson.clientSecret) {
      json = initiateJson;
      process.stderr.write(`\nAgent created.\n`);
    } else {
      const approvalRequestId = initiateJson.approval_request_id as string;
      const expiresIn = (initiateJson.expires_in as number) ?? 300;
      const pollInterval = (initiateJson.interval as number) ?? 5;

      process.stderr.write(`\nApproval required. Check your BKey mobile app.\n`);
      process.stderr.write(`  Agent:  ${opts.name}\n`);
      process.stderr.write(`  Scopes: ${scopes.join(', ')}\n\n`);

      const deadline = Date.now() + expiresIn * 1000;
      let approved: Record<string, unknown> | null = null;

      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, pollInterval * 1000));

        const remaining = Math.max(0, Math.round((deadline - Date.now()) / 1000));
        process.stderr.write(`\r  Waiting for approval on phone... (${remaining}s remaining)  `);

        const pollRes = await fetch(`${apiUrl}/oauth/agent-creation/${approvalRequestId}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(15_000),
        });

        const pollJson = (await pollRes.json()) as Record<string, unknown>;

        if (!pollRes.ok) {
          const err = (pollJson.error as Record<string, unknown>)?.message ?? `HTTP ${pollRes.status}`;
          process.stderr.write('\n');
          console.error(`Polling error: ${err}`);
          process.exit(1);
        }

        const status = pollJson.status as string;

        if (status === 'approved') {
          process.stderr.write('\n');
          approved = pollJson;
          break;
        }

        if (status === 'denied') {
          process.stderr.write('\n');
          console.error('\nAgent creation was denied on the BKey mobile app.');
          process.exit(1);
        }

        if (status === 'expired') {
          process.stderr.write('\n');
          console.error('\nAgent creation request expired before approval.');
          process.exit(1);
        }
      }

      if (!approved) {
        process.stderr.write('\n');
        console.error(`\nAgent creation timed out after ${expiresIn}s.`);
        process.exit(1);
      }

      json = approved;
    }

    if (opts.save) {
      saveAgentProfile(profileName, {
        apiUrl,
        clientId: json.clientId as string,
        clientSecret: json.clientSecret as string,
        name: opts.name,
        createdAt: new Date().toISOString(),
      });
      if (!opts.json) {
        console.log(`\nCredentials saved as agent profile "${profileName}".`);
      }
    }

    if (opts.json) {
      process.stdout.write(JSON.stringify({
        profile: opts.save ? profileName : undefined,
        clientId: json.clientId,
        clientSecret: json.clientSecret,
        allowedScopes: json.allowedScopes,
      }, null, 0) + '\n');
      return;
    }

    console.log('\nAgent OAuth client created!\n');
    console.log(`Profile:       ${profileName}${opts.save ? ' (saved)' : ' (NOT saved — pass --save to persist)'}`);
    console.log(`Display name:  ${opts.name}`);
    console.log(`Client ID:     ${json.clientId}`);
    console.log(`Client Secret: ${json.clientSecret}`);
    console.log(`Scopes:        ${(json.allowedScopes as string[]).join(', ')}`);
    console.log('\n  Save the client secret — it will not be shown again.\n');
    if (!opts.save) {
      console.log('Usage in agent/CI:');
      console.log(`  export BKEY_CLIENT_ID=${json.clientId}`);
      console.log(`  export BKEY_CLIENT_SECRET=${json.clientSecret}`);
      console.log('  bkey vault list');
    } else {
      console.log(`Usage: bkey <cmd> --agent --profile ${profileName}`);
      console.log(`       bkey <cmd> --agent                  # if "${profileName}" is the default agent`);
    }
  });

// ─── bkey auth status ──────────────────────────────────────────────

authCommand
  .command('status')
  .description('Show authentication status for the selected principal/profile')
  .option('--agent', 'Show an agent profile instead of the user session')
  .option('--human', 'Force human-principal view (default)')
  .option('--profile <name>', 'Show a specific profile instead of the default')
  .action(async (opts: { agent?: boolean; human?: boolean; profile?: string }) => {
    const envToken = process.env.BKEY_ACCESS_TOKEN;
    if (envToken && !opts.profile && !opts.agent) {
      console.log(`API URL:  ${resolveApiUrl()}`);
      console.log(`Token:    ${envToken.slice(0, 8)}...`);
      console.log(`Source:   environment (access token)`);
      console.log(`Method:   bearer`);
      return;
    }
    const envClientId = process.env.BKEY_CLIENT_ID;
    const envClientSecret = process.env.BKEY_CLIENT_SECRET;
    if (envClientId && envClientSecret && !opts.profile && !opts.human) {
      console.log(`API URL:  ${resolveApiUrl()}`);
      console.log(`Client:   ${envClientId}`);
      console.log(`Source:   environment (agent mode via env vars)`);
      console.log(`Method:   client_credentials`);
      return;
    }

    const principal: 'human' | 'agent' = opts.agent ? 'agent' : 'human';
    const profileName = opts.profile ?? resolveProfileName(principal);

    if (!profileName) {
      if (principal === 'human') {
        console.log('Status:   Not authenticated');
        console.log('Run:      bkey auth login');
      } else {
        console.log('Status:   No agent profile');
        console.log('Run:      bkey auth setup-agent --save');
      }
      const otherPrincipal: 'human' | 'agent' = principal === 'human' ? 'agent' : 'human';
      const other = listProfiles(otherPrincipal);
      if (other.length > 0) {
        console.log('');
        console.log(`${otherPrincipal[0]!.toUpperCase()}${otherPrincipal.slice(1)} profiles exist: ${other.join(', ')}`);
        console.log(`Inspect with: bkey auth status${otherPrincipal === 'agent' ? ' --agent' : ''}`);
      }
      return;
    }

    if (principal === 'human') {
      const target = getProfile('human', profileName) as ReturnType<typeof loadActiveHumanProfile>;
      if (!target) {
        console.log(`Status:   No human profile named "${profileName}".`);
        const available = listProfiles('human');
        if (available.length > 0) console.log(`Available: ${available.join(', ')}`);
        return;
      }
      const isDefault = getDefaultProfileName('human') === profileName;
      const isExpired = target.tokenExpiresAt
        ? new Date(target.tokenExpiresAt) < new Date()
        : false;

      console.log(`Profile:  ${profileName}${isDefault ? ' (default)' : ''}`);
      console.log(`API URL:  ${target.apiUrl}`);
      if (target.did) console.log(`DID:      ${target.did}`);
      console.log(`Method:   device authorization`);
      console.log(`Expires:  ${target.tokenExpiresAt ?? 'unknown'}`);

      if (isExpired) {
        console.log('Status:   Expired (will auto-refresh on next command)');
      } else {
        let liveStatus: string;
        try {
          const probeRes = await fetch(`${target.apiUrl}/v1/auth/sessions`, {
            headers: { Authorization: `Bearer ${target.accessToken}` },
            signal: AbortSignal.timeout(5_000),
          });
          if (probeRes.ok) {
            liveStatus = 'Active ✓';
          } else if (probeRes.status === 401) {
            liveStatus = 'Revoked (token rejected — run: bkey auth login)';
          } else {
            liveStatus = `Active (server returned ${probeRes.status})`;
          }
        } catch {
          liveStatus = 'Active (unverified — backend unreachable)';
        }
        console.log(`Status:   ${liveStatus}`);
      }

      const agentNames = listProfiles('agent');
      if (agentNames.length > 0) {
        console.log('');
        console.log(`Agent profiles: ${agentNames.join(', ')} (pass --agent to inspect).`);
      }
      return;
    }

    // Agent principal.
    const ap = getProfile('agent', profileName) as
      | { apiUrl: string; clientId: string; name?: string; createdAt?: string }
      | null;
    if (!ap) {
      console.log(`Status:   No agent profile named "${profileName}".`);
      const available = listProfiles('agent');
      if (available.length > 0) console.log(`Available: ${available.join(', ')}`);
      return;
    }
    const isDefault = getDefaultProfileName('agent') === profileName;
    console.log(`Profile:  ${profileName}${isDefault ? ' (default agent)' : ''}`);
    console.log(`API URL:  ${ap.apiUrl}`);
    console.log(`Client:   ${ap.clientId}`);
    if (ap.name) console.log(`Name:     ${ap.name}`);
    console.log(`Method:   client_credentials`);
    if (ap.createdAt) console.log(`Created:  ${ap.createdAt}`);
    const activeHuman = loadActiveHumanProfile();
    if (activeHuman?.did) {
      console.log(`Target DID (fallback): ${activeHuman.did}`);
    }
  });

// ─── bkey auth logout ──────────────────────────────────────────────

authCommand
  .command('logout')
  .description('Remove the active human profile (or a named profile) and revoke its tokens')
  .option('--agent', 'Remove an agent profile instead of the user session')
  .option('--human', 'Remove a human profile (default)')
  .option('--profile <name>', 'Remove a specific profile instead of the active/default')
  .option('--all', 'Remove ALL profiles (humans + agents) and any legacy files')
  .action(async (opts: { agent?: boolean; human?: boolean; profile?: string; all?: boolean }) => {
    if (opts.all) {
      const hp = loadActiveHumanProfile();
      if (hp?.refreshToken && hp.apiUrl) {
        try {
          await fetch(`${hp.apiUrl.replace(/\/$/, '')}/oauth/revoke`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: hp.refreshToken, client_id: CLI_CLIENT_ID }),
            signal: AbortSignal.timeout(5_000),
          });
        } catch {
          // Non-critical.
        }
      }
      for (const p of listProfiles('human')) deleteHumanProfile(p);
      for (const p of listProfiles('agent')) deleteAgentProfile(p);
      removeLegacyFiles();
      console.log('Logged out. All profiles removed.');
      return;
    }

    const principal: 'human' | 'agent' = opts.agent ? 'agent' : 'human';

    if (principal === 'agent') {
      const target = opts.profile ?? getDefaultProfileName('agent');
      if (!target) {
        console.log('No agent profile to remove.');
        return;
      }
      if (deleteAgentProfile(target)) {
        console.log(`Agent profile "${target}" removed.`);
      } else {
        console.error(`No agent profile named "${target}".`);
        process.exit(1);
      }
      return;
    }

    const target = opts.profile ?? getDefaultProfileName('human');
    if (!target) {
      console.log('No human profile to remove.');
      return;
    }

    const victim = getProfile('human', target) as
      | { apiUrl: string; refreshToken?: string }
      | null;
    if (victim?.refreshToken && victim.apiUrl) {
      try {
        await fetch(`${victim.apiUrl.replace(/\/$/, '')}/oauth/revoke`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: victim.refreshToken, client_id: CLI_CLIENT_ID }),
          signal: AbortSignal.timeout(5_000),
        });
      } catch {
        // Non-critical.
      }
    }

    if (deleteHumanProfile(target)) {
      console.log(`Human profile "${target}" logged out and removed.`);
    } else {
      console.error(`No human profile named "${target}".`);
      process.exit(1);
    }
  });
