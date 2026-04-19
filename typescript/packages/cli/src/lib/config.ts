// copyright © 2025-2026 bkey inc. all rights reserved.

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { CLI_CLIENT_ID } from './constants.js';

const CONFIG_DIR = join(homedir(), '.bkey');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const AGENT_CONFIG_FILE = join(CONFIG_DIR, 'agent.json');

export interface AgentConfig {
  clientId: string;
  clientSecret: string;
  name: string;
  createdAt: string;
}

export interface BKeyConfig {
  apiUrl: string;
  /** OAuth access token (EdDSA JWT). */
  accessToken?: string;
  /** OAuth refresh token (EdDSA JWT). */
  refreshToken?: string;
  /** ISO timestamp when the access token expires. */
  tokenExpiresAt?: string;
  /** The user's DID (decoded from the access token sub claim). */
  did?: string;
  /** Agent mode: OAuth client ID (from env vars). */
  clientId?: string;
  /** Agent mode: OAuth client secret (from env vars). */
  clientSecret?: string;
}

function ensureDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

export function loadConfig(): BKeyConfig | null {
  if (!existsSync(CONFIG_FILE)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as BKeyConfig;
  } catch {
    return null;
  }
}

export function saveConfig(config: BKeyConfig): void {
  ensureDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

/** Remove the user session config (~/.bkey/config.json). */
export function deleteUserConfig(): void {
  if (existsSync(CONFIG_FILE)) {
    unlinkSync(CONFIG_FILE);
  }
}

/** Remove persistent agent credentials (~/.bkey/agent.json). */
export function deleteAgentConfig(): void {
  if (existsSync(AGENT_CONFIG_FILE)) {
    unlinkSync(AGENT_CONFIG_FILE);
  }
}

/**
 * Remove both user session and agent credentials. Kept for backward compat —
 * prefer `deleteUserConfig()` or `deleteAgentConfig()` directly.
 */
export function deleteConfig(): void {
  deleteUserConfig();
  deleteAgentConfig();
}

export function loadAgentConfig(): AgentConfig | null {
  if (!existsSync(AGENT_CONFIG_FILE)) return null;
  try {
    return JSON.parse(readFileSync(AGENT_CONFIG_FILE, 'utf8')) as AgentConfig;
  } catch {
    return null;
  }
}

export function saveAgentConfig(config: AgentConfig): void {
  ensureDir();
  writeFileSync(AGENT_CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

/** Resolve the API base URL from env vars. */
export function resolveApiUrl(): string {
  return (process.env.BKEY_BASE_URL || 'https://api.bkey.id').replace(/\/$/, '');
}

export interface RequireConfigOptions {
  /**
   * Force agent mode (use ~/.bkey/agent.json). Equivalent to BKEY_MODE=agent.
   * When omitted, defaults to the human user session (~/.bkey/config.json)
   * unless env-var overrides are present.
   */
  agent?: boolean;
}

/**
 * True when the caller is asking for agent mode — either via an explicit flag
 * or BKEY_MODE=agent in the environment. Keep this in sync with
 * {@link requireConfig}'s resolution.
 */
export function isAgentModeRequested(opts?: RequireConfigOptions): boolean {
  if (opts?.agent) return true;
  const mode = process.env.BKEY_MODE?.trim().toLowerCase();
  return mode === 'agent';
}

/**
 * Resolve auth config. Two principals, resolved separately:
 *
 *   - Human user (default): config.json from `bkey auth login`.
 *   - Agent (opt-in via --agent, BKEY_MODE=agent, or BKEY_CLIENT_ID/SECRET env vars):
 *     agent.json from `bkey auth setup-agent --save`, or env vars.
 *
 * Resolution order:
 *   1. BKEY_ACCESS_TOKEN env (direct override, rarely used)
 *   2. BKEY_CLIENT_ID + BKEY_CLIENT_SECRET env (implicit agent mode)
 *   3. If agent mode requested → ~/.bkey/agent.json (else skipped — agent.json
 *      never silently wins over a logged-in user session)
 *   4. ~/.bkey/config.json (user session)
 *   5. Error with a hint appropriate to the mode.
 */
export function requireConfig(opts?: RequireConfigOptions): BKeyConfig {
  const agentRequested = isAgentModeRequested(opts);

  // 1. Direct access token override (highest priority — explicit token wins).
  const envToken = process.env.BKEY_ACCESS_TOKEN;
  if (envToken) {
    return {
      apiUrl: resolveApiUrl(),
      accessToken: envToken,
    };
  }

  // 2. Agent creds from env vars — implicit agent mode regardless of --agent flag.
  const envClientId = process.env.BKEY_CLIENT_ID;
  const envClientSecret = process.env.BKEY_CLIENT_SECRET;
  if (envClientId && envClientSecret) {
    return {
      apiUrl: resolveApiUrl(),
      clientId: envClientId,
      clientSecret: envClientSecret,
    };
  }

  // 3. Persistent agent creds — only when agent mode was explicitly requested.
  //    This prevents `agent.json`'s mere existence from hijacking a human's terminal.
  if (agentRequested) {
    const agentConfig = loadAgentConfig();
    if (agentConfig?.clientId && agentConfig?.clientSecret) {
      return {
        apiUrl: resolveApiUrl(),
        clientId: agentConfig.clientId,
        clientSecret: agentConfig.clientSecret,
      };
    }
    console.error('Agent mode requested but no agent credentials are available.');
    console.error('Either set BKEY_CLIENT_ID + BKEY_CLIENT_SECRET env vars,');
    console.error('or run: bkey auth setup-agent --save');
    process.exit(1);
  }

  // 4. Human user session (default).
  const config = loadConfig();
  if (config?.accessToken) {
    config.clientId ??= CLI_CLIENT_ID;
    return config;
  }

  console.error('Not logged in. Run: bkey auth login');
  console.error('Or, to run as an agent, set BKEY_MODE=agent (with agent.json saved) or BKEY_CLIENT_ID + BKEY_CLIENT_SECRET.');
  process.exit(1);
}
