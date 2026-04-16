// copyright © 2025-2026 bkey inc. all rights reserved.

import { Command } from 'commander';
import { saveConfig, loadConfig, deleteConfig, requireConfig, resolveApiUrl } from '../lib/config.js';
import { CLI_CLIENT_ID } from '../lib/constants.js';
import { pollDeviceAuth } from '../lib/device-auth-poll.js';

export const authCommand = new Command('auth')
  .description('Manage BKey CLI authentication');

// ─── bkey auth login ───────────────────────────────────────────────

authCommand
  .command('login')
  .description('Authenticate with the BKey backend via device authorization flow')
  .option('--base-url <url>', 'BKey base URL (default: $BKEY_BASE_URL or https://api.bkey.id)')
  .action(async (opts: { baseUrl?: string }) => {
    const apiUrl = (opts.baseUrl || process.env.BKEY_BASE_URL || 'https://api.bkey.id').replace(/\/$/, '');

    console.log('Starting device authorization flow...\n');

    // 1. Initiate device authorization
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
    // Override verification URI when base URL is explicitly configured
    // (either via --base-url flag or BKEY_BASE_URL env var), since the
    // server-returned URI may not be reachable from this environment
    // (e.g. Docker containers, OpenClaw demos).
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

    // 2. Display user code and verification URL
    console.log('┌─────────────────────────────────────────┐');
    console.log(`│  Your code:  ${userCode}                │`);
    console.log('├─────────────────────────────────────────┤');
    console.log(`│  Open: ${verificationUriComplete}`);
    console.log(`│  Or approve in the BKey app on your phone`);
    console.log('└─────────────────────────────────────────┘');

    // Print QR code for headless environments (Docker, SSH, OpenClaw)
    // Encode the deep link (short URL = cleaner QR). Use 'utf8' type which
    // outputs plain Unicode block chars — works in all terminals including
    // OpenClaw's tool output renderer (no ANSI escape codes).
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

    // 3. Auto-open browser with code pre-filled (like gh auth login)
    try {
      // Validate URL scheme to prevent protocol handler abuse from a malicious server
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

    // 3. Poll for approval
    try {
      const tokens = await pollDeviceAuth(apiUrl, deviceCode, CLI_CLIENT_ID, interval, undefined, expiresIn);

      // 4. Decode the access token to extract the DID for display/config.
      //    No signature verification here — this is purely cosmetic. The server
      //    validates the JWT on every API call; we only read `sub` for UX.
      let did = '';
      try {
        const payload = JSON.parse(
          Buffer.from(tokens.access_token.split('.')[1]!, 'base64url').toString(),
        );
        did = payload.sub ?? '';
      } catch {
        // Non-critical — DID is for display only
      }

      // 5. Save tokens to config
      saveConfig({
        apiUrl,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        tokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
        did,
      });

      console.log('\nAuthenticated successfully!');
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
  .description('Create an OAuth client for agent/CI use (requires prior login)')
  .option('--base-url <url>', 'BKey base URL (overrides saved config)')
  .option('--name <name>', 'Client name', 'My Agent')
  .option('--scopes <scopes>', 'Comma-separated scopes', 'vault:access,vault:store,signing:create,signing:read,identity:read,approve:action,approve:payment,x402:authorize,x402:address,x402:limits')
  .option('--json', 'Output credentials as JSON (for scripting)')
  .option('--save', 'Save credentials to ~/.bkey/agent.json for persistent agent mode')
  .action(async (opts: { baseUrl?: string; name: string; scopes: string; json?: boolean; save?: boolean }) => {
    // setup-agent needs an interactive login token, not agent credentials.
    // Read the config file directly to bypass agent env var priority.
    const { loadConfig } = await import('../lib/config.js');
    const config = loadConfig();
    if (!config?.accessToken) {
      console.error('You must be logged in first. Run: bkey auth login');
      console.error('(Agent env vars like BKEY_CLIENT_ID cannot be used to create new clients.)');
      process.exit(1);
    }

    // Allow --base-url to override the saved config URL
    if (opts.baseUrl) {
      config.apiUrl = opts.baseUrl.replace(/\/$/, '');
    }

    // Refresh token if expired before making the API call
    const { BKey } = await import('@bkey/sdk');
    const api = new BKey(config);
    const token = await api.getValidToken();

    const apiUrl = config.apiUrl.replace(/\/$/, '');
    const scopes = opts.scopes.split(',').map((s) => s.trim());

    // Step 1: Initiate approval — backend sends push to phone
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

    // The backend may return credentials directly (no approval required)
    // or return an approval_request_id for async approval via mobile.
    let json: Record<string, unknown>;

    if (initiateJson.clientId && initiateJson.clientSecret) {
      // Direct creation — backend returned credentials immediately
      json = initiateJson;
      process.stderr.write(`\nAgent created.\n`);
    } else {
      // Async approval flow — poll until approved/denied/expired
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

    // Save to ~/.bkey/agent.json if --save flag is set
    if (opts.save) {
      const { saveAgentConfig } = await import('../lib/config.js');
      saveAgentConfig({
        clientId: json.clientId as string,
        clientSecret: json.clientSecret as string,
        name: opts.name,
        createdAt: new Date().toISOString(),
      });
      if (!opts.json) {
        console.log('Credentials saved to ~/.bkey/agent.json');
      }
    }

    // JSON output for scripting (setup.sh, CI/CD)
    if (opts.json) {
      process.stdout.write(JSON.stringify({
        clientId: json.clientId,
        clientSecret: json.clientSecret,
        allowedScopes: json.allowedScopes,
      }) + '\n');
      return;
    }

    console.log('\nAgent OAuth client created!\n');
    console.log(`Client ID:     ${json.clientId}`);
    console.log(`Client Secret: ${json.clientSecret}`);
    console.log(`Scopes:        ${(json.allowedScopes as string[]).join(', ')}`);
    console.log('\n  Save the client secret — it will not be shown again.\n');
    console.log('Usage in agent/CI:');
    console.log(`  export BKEY_CLIENT_ID=${json.clientId}`);
    console.log(`  export BKEY_CLIENT_SECRET=${json.clientSecret}`);
    console.log('  bkey vault list');
  });

// ─── bkey auth status ──────────────────────────────────────────────

authCommand
  .command('status')
  .description('Show current authentication status')
  .action(async () => {
    let source = 'none';
    let method = '';

    // Check agent mode env vars
    const envClientId = process.env.BKEY_CLIENT_ID;
    const envClientSecret = process.env.BKEY_CLIENT_SECRET;
    if (envClientId && envClientSecret) {
      source = 'environment (agent mode)';
      method = 'client_credentials';
      console.log(`API URL:  ${resolveApiUrl()}`);
      console.log(`Client:   ${envClientId}`);
      console.log(`Source:   ${source}`);
      console.log(`Method:   ${method}`);
      return;
    }

    // Check direct token env var
    const envToken = process.env.BKEY_ACCESS_TOKEN;
    if (envToken) {
      source = 'environment (access token)';
      method = 'bearer';
      console.log(`API URL:  ${resolveApiUrl()}`);
      console.log(`Token:    ${envToken.slice(0, 8)}...`);
      console.log(`Source:   ${source}`);
      return;
    }

    // Check persistent agent credentials (~/.bkey/agent.json)
    const { loadAgentConfig } = await import('../lib/config.js');
    const agentConfig = loadAgentConfig();
    if (agentConfig?.clientId && agentConfig?.clientSecret) {
      source = 'agent.json (persistent agent mode)';
      method = 'client_credentials';
      console.log(`API URL:  ${resolveApiUrl()}`);
      console.log(`Client:   ${agentConfig.clientId}`);
      console.log(`Name:     ${agentConfig.name}`);
      console.log(`Source:   ${source}`);
      console.log(`Method:   ${method}`);
      console.log(`Created:  ${agentConfig.createdAt}`);
      return;
    }

    // Check config file
    const config = loadConfig();
    if (!config?.accessToken) {
      console.log('Status:   Not authenticated');
      console.log('Run:      bkey auth login');
      return;
    }

    source = 'config file';
    method = 'device authorization';

    const isExpired = config.tokenExpiresAt
      ? new Date(config.tokenExpiresAt) < new Date()
      : false;

    console.log(`API URL:  ${config.apiUrl}`);
    if (config.did) console.log(`DID:      ${config.did}`);
    console.log(`Method:   ${method}`);
    console.log(`Source:   ${source}`);
    console.log(`Expires:  ${config.tokenExpiresAt ?? 'unknown'}`);

    if (isExpired) {
      console.log('Status:   Expired (will auto-refresh on next command)');
      return;
    }

    // Probe the backend to verify the token is actually accepted.
    // A locally non-expired token can still be invalid if the backend was
    // restarted, the DB was wiped, or the session was remotely revoked.
    let liveStatus: string;
    try {
      const probeRes = await fetch(`${config.apiUrl}/v1/auth/sessions`, {
        headers: { Authorization: `Bearer ${config.accessToken}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (probeRes.ok) {
        liveStatus = 'Active ✓';
      } else if (probeRes.status === 401) {
        liveStatus = 'Revoked (token rejected by server — run: bkey auth login)';
      } else {
        liveStatus = `Active (server returned ${probeRes.status} — check backend)`;
      }
    } catch {
      liveStatus = 'Active (unverified — backend unreachable)';
    }

    console.log(`Status:   ${liveStatus}`);
  });

// ─── bkey auth logout ──────────────────────────────────────────────

authCommand
  .command('logout')
  .description('Revoke tokens and clear stored credentials')
  .action(async () => {
    const config = loadConfig();
    if (config?.refreshToken && config.apiUrl) {
      // Revoke the refresh token on the server
      try {
        await fetch(`${config.apiUrl.replace(/\/$/, '')}/oauth/revoke`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: config.refreshToken, client_id: CLI_CLIENT_ID }),
          signal: AbortSignal.timeout(5_000),
        });
      } catch {
        // Non-critical — server-side token will expire naturally
      }
    }

    deleteConfig();
    console.log('Logged out. Tokens revoked.');
  });
