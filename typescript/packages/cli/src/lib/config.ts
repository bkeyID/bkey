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

export function deleteConfig(): void {
  if (existsSync(CONFIG_FILE)) {
    unlinkSync(CONFIG_FILE);
  }
  if (existsSync(AGENT_CONFIG_FILE)) {
    unlinkSync(AGENT_CONFIG_FILE);
  }
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

/**
 * Resolve auth config with priority:
 *   1. BKEY_ACCESS_TOKEN env var → direct override (highest priority)
 *   2. BKEY_CLIENT_ID + BKEY_CLIENT_SECRET env vars → client_credentials (agent mode)
 *   3. ~/.bkey/agent.json → persistent agent credentials (created by --save)
 *   4. Config file accessToken → use with refresh
 *   5. Error: prompt to run `bkey auth login`
 */
export function requireConfig(): BKeyConfig {
  // 1. Direct access token override (highest priority — explicit token wins over credentials)
  const envToken = process.env.BKEY_ACCESS_TOKEN;
  if (envToken) {
    return {
      apiUrl: resolveApiUrl(),
      accessToken: envToken,
    };
  }

  // 2. Agent mode: OAuth client credentials from env vars
  const envClientId = process.env.BKEY_CLIENT_ID;
  const envClientSecret = process.env.BKEY_CLIENT_SECRET;
  if (envClientId && envClientSecret) {
    return {
      apiUrl: resolveApiUrl(),
      clientId: envClientId,
      clientSecret: envClientSecret,
    };
  }

  // 3. Persistent agent credentials from ~/.bkey/agent.json
  const agentConfig = loadAgentConfig();
  if (agentConfig?.clientId && agentConfig?.clientSecret) {
    return {
      apiUrl: resolveApiUrl(),
      clientId: agentConfig.clientId,
      clientSecret: agentConfig.clientSecret,
    };
  }

  // 4. Config file with OAuth tokens (user mode — set clientId for SDK refresh)
  const config = loadConfig();
  if (config?.accessToken) {
    config.clientId ??= CLI_CLIENT_ID;
    return config;
  }

  console.error('Not logged in. Run: bkey auth login');
  console.error('Or set BKEY_CLIENT_ID + BKEY_CLIENT_SECRET environment variables (agent mode).');
  process.exit(1);
}
