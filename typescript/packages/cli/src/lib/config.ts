// copyright © 2025-2026 bkey inc. all rights reserved.

import { BKey } from '@bkey/sdk';
import { CLI_CLIENT_ID } from './constants.js';
import {
  getDefaultProfileName,
  getProfile,
  listProfiles,
  saveHumanProfile as saveHumanProfileToStore,
  saveAgentProfile as saveAgentProfileToStore,
  deleteProfile,
  type AgentProfile,
  type HumanProfile,
  type Principal,
} from './profiles.js';

export type { AgentProfile, HumanProfile, Principal } from './profiles.js';

/**
 * The resolved credential bundle handed to the SDK. Exactly one of
 * `accessToken` / (`clientId` + `clientSecret`) is set depending on the
 * principal the caller resolved to.
 */
export interface BKeyConfig {
  apiUrl: string;
  /** OAuth access token (EdDSA JWT) — set in human mode. */
  accessToken?: string;
  /** OAuth refresh token — set in human mode. */
  refreshToken?: string;
  /** ISO timestamp when the access token expires. */
  tokenExpiresAt?: string;
  /** Human user DID decoded from the access token. */
  did?: string;
  /** OAuth client ID — set in agent mode. */
  clientId?: string;
  /** OAuth client secret — set in agent mode. */
  clientSecret?: string;
}

export interface RequireConfigOptions {
  /** Force a principal, overriding command-implied defaults. */
  principal?: Principal;
  /** Named profile within the principal (overrides BKEY_PROFILE + saved default). */
  profile?: string;
  /** Back-compat shortcut: equivalent to `principal: 'agent'`. */
  agent?: boolean;
  /** Back-compat shortcut: equivalent to `principal: 'human'`. */
  human?: boolean;
}

let warnedEnvOnce = false;

/**
 * Emit a one-time stderr notice when env-var state around the API base URL
 * deserves the user's attention:
 *   - $BKEY_BASE_URL is set alone (deprecated in favor of $BKEY_API_URL).
 *   - Both names are set AND point at different hosts — the new precedence
 *     silently prefers $BKEY_API_URL, which would be a surprising host change
 *     for scripts that still relied on $BKEY_BASE_URL. We never pick for the
 *     user in that case; we just surface the conflict.
 */
function maybeWarnEnvOnce(): void {
  if (warnedEnvOnce) return;
  const api = process.env.BKEY_API_URL;
  const legacy = process.env.BKEY_BASE_URL;
  if (api && legacy && api.replace(/\/$/, '') !== legacy.replace(/\/$/, '')) {
    warnedEnvOnce = true;
    process.stderr.write(
      `bkey: BKEY_API_URL (${api}) and BKEY_BASE_URL (${legacy}) are both set and differ; `
        + `BKEY_API_URL wins. Unset BKEY_BASE_URL to silence this notice.\n`,
    );
    return;
  }
  if (!api && legacy) {
    warnedEnvOnce = true;
    process.stderr.write(
      'bkey: BKEY_BASE_URL is deprecated; use BKEY_API_URL instead.\n',
    );
  }
}

/**
 * Resolve the API base URL. Precedence:
 *   1. explicit arg (e.g. `--base-url` flag)
 *   2. `$BKEY_API_URL`
 *   3. `$BKEY_BASE_URL` (deprecated, one-time stderr warning)
 *   4. `https://api.bkey.id`
 */
export function resolveApiUrl(explicitBaseUrl?: string): string {
  if (!explicitBaseUrl) maybeWarnEnvOnce();
  const raw =
    explicitBaseUrl
    || process.env.BKEY_API_URL
    || process.env.BKEY_BASE_URL
    || 'https://api.bkey.id';
  return raw.replace(/\/$/, '');
}

/** True iff the caller asked for agent mode via flag or `BKEY_MODE=agent`. */
export function isAgentModeRequested(opts?: RequireConfigOptions): boolean {
  if (opts?.agent) return true;
  if (opts?.principal === 'agent') return true;
  const mode = process.env.BKEY_MODE?.trim().toLowerCase();
  return mode === 'agent';
}

/** Resolve which principal the caller wants. Does NOT read any profile data. */
export function resolvePrincipal(opts?: RequireConfigOptions): Principal {
  if (opts?.principal) return opts.principal;
  if (opts?.agent) return 'agent';
  if (opts?.human) return 'human';
  const mode = process.env.BKEY_MODE?.trim().toLowerCase();
  if (mode === 'agent') return 'agent';
  if (mode === 'human') return 'human';
  return 'human';
}

/** Resolve which profile name the caller wants for a given principal. */
export function resolveProfileName(
  principal: Principal,
  opts?: RequireConfigOptions,
): string | undefined {
  if (opts?.profile) return opts.profile;
  const env = process.env.BKEY_PROFILE?.trim();
  if (env) return env;
  return getDefaultProfileName(principal);
}

/**
 * Resolve auth config per the codex-guided precedence chain:
 *
 *   1. BKEY_ACCESS_TOKEN env (direct token override, bypasses profiles).
 *   2. BKEY_CLIENT_ID + BKEY_CLIENT_SECRET env (implicit agent mode; bypasses).
 *   3. Principal: opts.principal > --agent/--human > BKEY_MODE > default 'human'.
 *   4. Profile name: opts.profile > BKEY_PROFILE > state.defaults[principal].
 *   5. Error with a hint listing available profiles of that principal.
 */
export function requireConfig(opts?: RequireConfigOptions): BKeyConfig {
  // 1. Direct access-token override (highest priority).
  const envToken = process.env.BKEY_ACCESS_TOKEN;
  if (envToken) {
    return {
      apiUrl: resolveApiUrl(),
      accessToken: envToken,
    };
  }

  // 2. Agent creds from env vars — implicit agent mode regardless of --human / --profile.
  const envClientId = process.env.BKEY_CLIENT_ID;
  const envClientSecret = process.env.BKEY_CLIENT_SECRET;
  if (envClientId && envClientSecret) {
    return {
      apiUrl: resolveApiUrl(),
      clientId: envClientId,
      clientSecret: envClientSecret,
    };
  }

  const principal = resolvePrincipal(opts);
  const profileName = resolveProfileName(principal, opts);

  if (!profileName) {
    printMissingDefaultError(principal);
    process.exit(1);
  }

  const profile = getProfile(principal, profileName);
  if (!profile) {
    printMissingProfileError(principal, profileName);
    process.exit(1);
  }

  if (principal === 'human') {
    const hp = profile as HumanProfile;
    return {
      apiUrl: hp.apiUrl,
      accessToken: hp.accessToken,
      refreshToken: hp.refreshToken,
      tokenExpiresAt: hp.tokenExpiresAt,
      did: hp.did,
      clientId: CLI_CLIENT_ID, // lets the SDK refresh the user token
    };
  }

  const ap = profile as AgentProfile;
  return {
    apiUrl: ap.apiUrl,
    clientId: ap.clientId,
    clientSecret: ap.clientSecret,
  };
}

function printMissingDefaultError(principal: Principal): void {
  const available = listProfiles(principal);
  if (principal === 'human') {
    console.error('No default human profile — run `bkey auth login` first.');
    if (available.length > 0) {
      console.error(`Available human profiles: ${available.join(', ')}`);
      console.error('Pick one with --profile <name> or set a default with `bkey profiles use <name>`.');
    } else {
      const agents = listProfiles('agent');
      if (agents.length > 0) {
        console.error(`Agent profiles exist: ${agents.join(', ')}. Use --agent --profile <name> to run as an agent.`);
      }
    }
  } else {
    console.error('No default agent profile — run `bkey auth setup-agent --save` first.');
    if (available.length > 0) {
      console.error(`Available agent profiles: ${available.join(', ')}`);
      console.error('Pick one with --profile <name> or set a default with `bkey profiles use <name> --agent`.');
    }
  }
}

function printMissingProfileError(principal: Principal, name: string): void {
  const available = listProfiles(principal);
  console.error(`No ${principal} profile named "${name}".`);
  if (available.length > 0) {
    console.error(`Available ${principal} profiles: ${available.join(', ')}`);
  } else {
    console.error(
      principal === 'human'
        ? 'Run `bkey auth login --profile <name>` to create one.'
        : 'Run `bkey auth setup-agent --save --profile <name>` to create one.',
    );
  }
}

// ─── authenticated client factory ──────────────────────────────────

/**
 * Construct a BKey SDK client for the resolved principal+profile. When the
 * principal resolves to a disk-backed human profile, wire the SDK's
 * onTokenRefresh + reloadConfig hooks so refreshed access/refresh tokens are
 * persisted back to the profile store. Without this, the SDK refreshes
 * tokens in-memory only, the new refresh token never reaches disk, and the
 * next invocation burns the old refresh token with "refresh token already
 * used". Direct env-var callers (`BKEY_ACCESS_TOKEN`, `BKEY_CLIENT_ID`) own
 * their own credential lifecycle; agent profiles use client_credentials
 * which doesn't involve refresh tokens. Only the human-profile path needs
 * this plumbing.
 */
export function createClient(opts?: RequireConfigOptions): BKey {
  const config = requireConfig(opts);
  const api = new BKey(config);

  if (process.env.BKEY_ACCESS_TOKEN) return api;
  if (process.env.BKEY_CLIENT_ID && process.env.BKEY_CLIENT_SECRET) return api;
  if (resolvePrincipal(opts) !== 'human') return api;

  const humanProfileName = resolveProfileName('human', opts);
  if (!humanProfileName) return api;
  wireHumanProfilePersistence(api, humanProfileName);
  return api;
}

/**
 * Wire the SDK's token-refresh hooks to persist rotated tokens back to the
 * named human profile. Exported for the `auth setup-agent` path, which
 * constructs its own BKey instance directly rather than going through
 * `createClient`.
 */
export function wireHumanProfilePersistence(api: BKey, humanProfileName: string): void {
  const preservedDid = (getProfile('human', humanProfileName) as HumanProfile | null)?.did;
  api.onTokenRefresh = (updated) => {
    if (!updated.accessToken) return;
    saveHumanProfileToStore(humanProfileName, {
      apiUrl: updated.apiUrl,
      accessToken: updated.accessToken,
      refreshToken: updated.refreshToken,
      tokenExpiresAt: updated.tokenExpiresAt,
      did: preservedDid,
    });
  };
  api.reloadConfig = () => {
    const fresh = getProfile('human', humanProfileName) as HumanProfile | null;
    if (!fresh) return null;
    return {
      apiUrl: fresh.apiUrl,
      accessToken: fresh.accessToken,
      refreshToken: fresh.refreshToken,
      tokenExpiresAt: fresh.tokenExpiresAt,
      clientId: CLI_CLIENT_ID,
    };
  };
}

// ─── human profile (session) helpers ────────────────────────────────

/**
 * Load the active/default human profile without triggering full principal
 * resolution. Used by `approve` / `checkout` to look up the saved user DID
 * (approval target) regardless of the current principal.
 */
export function loadActiveHumanProfile(): HumanProfile | null {
  const name = getDefaultProfileName('human');
  if (!name) return null;
  return getProfile('human', name) as HumanProfile | null;
}

/** Overwrite (or create) a human profile. */
export function saveHumanProfile(name: string, profile: HumanProfile): void {
  saveHumanProfileToStore(name, profile);
}

/** Overwrite (or create) an agent profile. */
export function saveAgentProfile(name: string, profile: AgentProfile): void {
  saveAgentProfileToStore(name, profile);
}

/** Does an agent profile with this name already exist? Used for collision checks. */
export function agentProfileExists(name: string): boolean {
  return getProfile('agent', name) !== null;
}

/** Does a human profile with this name already exist? */
export function humanProfileExists(name: string): boolean {
  return getProfile('human', name) !== null;
}

/** Delete the named human profile (or the default if name omitted). */
export function deleteHumanProfile(name?: string): boolean {
  const target = name ?? getDefaultProfileName('human');
  if (!target) return false;
  return deleteProfile('human', target);
}

/** Delete the named agent profile (or the default if name omitted). */
export function deleteAgentProfile(name?: string): boolean {
  const target = name ?? getDefaultProfileName('agent');
  if (!target) return false;
  return deleteProfile('agent', target);
}

// ─── back-compat shims for callers not yet threaded through principals ──────

/** Active/default human profile in the legacy `BKeyConfig` shape. */
export function loadConfig(): BKeyConfig | null {
  const hp = loadActiveHumanProfile();
  if (!hp) return null;
  return {
    apiUrl: hp.apiUrl,
    accessToken: hp.accessToken,
    refreshToken: hp.refreshToken,
    tokenExpiresAt: hp.tokenExpiresAt,
    did: hp.did,
    clientId: CLI_CLIENT_ID,
  };
}

/** Active/default agent profile; returns null when no default is set. */
export function loadAgentConfig(): (AgentProfile & { name?: string }) | null {
  const name = getDefaultProfileName('agent');
  if (!name) return null;
  return getProfile('agent', name) as AgentProfile | null;
}

// Re-exports so command files can import everything profile-related from here.
export {
  invalidateStoreCache,
  listProfiles,
  getDefaultProfileName,
  renameProfile,
  setDefaultProfileName,
  STORE_PATHS,
  storeStat,
  slugifyProfileName,
  removeLegacyFiles,
} from './profiles.js';
