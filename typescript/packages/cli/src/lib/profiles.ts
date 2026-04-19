// copyright © 2025-2026 bkey inc. all rights reserved.

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  unlinkSync,
  renameSync,
  openSync,
  fsyncSync,
  closeSync,
  statSync,
  chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export type Principal = 'human' | 'agent';

export interface HumanProfile {
  apiUrl: string;
  did?: string;
  accessToken: string;
  refreshToken?: string;
  tokenExpiresAt?: string;
}

export interface AgentProfile {
  apiUrl: string;
  clientId: string;
  clientSecret: string;
  /** Display name shown on the phone at approval time (e.g., "Deploy Bot"). */
  name?: string;
  createdAt?: string;
}

export interface ProfilesStore {
  version: 1;
  defaults: {
    human?: string;
    agent?: string;
  };
  humans: Record<string, HumanProfile>;
  agents: Record<string, AgentProfile>;
}

const CONFIG_DIR = join(homedir(), '.bkey');
const STORE_FILE = join(CONFIG_DIR, 'profiles.json');
const STORE_BACKUP = join(CONFIG_DIR, 'profiles.json.bak');
// Legacy single-file paths migrated into the new store on first access.
const LEGACY_CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const LEGACY_AGENT_FILE = join(CONFIG_DIR, 'agent.json');

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Convert a human-entered display name into a safe profile identifier. */
export function slugifyProfileName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'default';
}

function ensureDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: DIR_MODE });
  }
}

function emptyStore(): ProfilesStore {
  return { version: 1, defaults: {}, humans: {}, agents: {} };
}

/**
 * Validate the shape of a loaded store. We tolerate extra fields (forward
 * compat) but reject anything that would break reads downstream.
 */
function validateStore(value: unknown): asserts value is ProfilesStore {
  if (!value || typeof value !== 'object') throw new Error('profiles store must be a JSON object');
  const v = value as Partial<ProfilesStore>;
  if (v.version !== 1) throw new Error(`unsupported profiles store version: ${String(v.version)}`);
  if (!v.defaults || typeof v.defaults !== 'object') throw new Error('profiles.defaults missing');
  if (!v.humans || typeof v.humans !== 'object') throw new Error('profiles.humans missing');
  if (!v.agents || typeof v.agents !== 'object') throw new Error('profiles.agents missing');

  for (const [name, p] of Object.entries(v.humans)) {
    if (!p || typeof p !== 'object') throw new Error(`humans[${name}] malformed`);
    const hp = p as Partial<HumanProfile>;
    if (typeof hp.apiUrl !== 'string') throw new Error(`humans[${name}].apiUrl missing`);
    if (typeof hp.accessToken !== 'string') throw new Error(`humans[${name}].accessToken missing`);
  }
  for (const [name, p] of Object.entries(v.agents)) {
    if (!p || typeof p !== 'object') throw new Error(`agents[${name}] malformed`);
    const ap = p as Partial<AgentProfile>;
    if (typeof ap.apiUrl !== 'string') throw new Error(`agents[${name}].apiUrl missing`);
    if (typeof ap.clientId !== 'string') throw new Error(`agents[${name}].clientId missing`);
    if (typeof ap.clientSecret !== 'string') throw new Error(`agents[${name}].clientSecret missing`);
  }
}

/**
 * Atomic write: tmp in same dir → fsync → rename → fsync dir. Also rolls the
 * previous `profiles.json` to `profiles.json.bak` so a single bad write can't
 * clobber every profile the user has.
 */
function atomicWriteStore(store: ProfilesStore): void {
  ensureDir();

  const body = JSON.stringify(store, null, 2) + '\n';
  const tmp = `${STORE_FILE}.tmp.${process.pid}`;
  writeFileSync(tmp, body, { mode: FILE_MODE });
  try {
    const fd = openSync(tmp, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // fsync is best-effort; if the FS doesn't support it we continue.
  }

  if (existsSync(STORE_FILE)) {
    try {
      renameSync(STORE_FILE, STORE_BACKUP);
    } catch {
      // Non-critical: if the backup rotation fails we still prefer to land
      // the new store than to refuse the write.
    }
  }

  renameSync(tmp, STORE_FILE);

  try {
    const dirFd = openSync(CONFIG_DIR, 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // fsync on directory is best-effort.
  }

  // Re-assert mode in case the umask on rename left it weaker than 0600.
  try {
    chmodSync(STORE_FILE, FILE_MODE);
  } catch {
    // Non-critical.
  }
}

function readStoreFile(path: string): ProfilesStore | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    validateStore(parsed);
    return parsed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`warning: ${path} unreadable (${msg})\n`);
    return null;
  }
}

/**
 * Lazily migrate `~/.bkey/config.json` and `~/.bkey/agent.json` (0.2.x) into
 * the new store on first access. Writes a one-time stderr notice so the
 * schema change isn't completely silent.
 *
 * Legacy files are left in place as read-only fallbacks for one release so
 * users can roll back by downgrading.
 *
 * TODO(0.4.0): delete this function, the LEGACY_* constants, and
 * `removeLegacyFiles()`. Tracking issue: bkeyID/bkey#27.
 */
function migrateLegacy(): ProfilesStore | null {
  const hasLegacy = existsSync(LEGACY_CONFIG_FILE) || existsSync(LEGACY_AGENT_FILE);
  if (!hasLegacy) return null;

  const store = emptyStore();

  if (existsSync(LEGACY_CONFIG_FILE)) {
    try {
      const raw = JSON.parse(readFileSync(LEGACY_CONFIG_FILE, 'utf8')) as Partial<HumanProfile>;
      if (typeof raw.apiUrl === 'string' && typeof raw.accessToken === 'string') {
        store.humans.default = {
          apiUrl: raw.apiUrl,
          did: raw.did,
          accessToken: raw.accessToken,
          refreshToken: raw.refreshToken,
          tokenExpiresAt: raw.tokenExpiresAt,
        };
        store.defaults.human = 'default';
      }
    } catch {
      // Ignore malformed legacy file — better to migrate what we can.
    }
  }

  if (existsSync(LEGACY_AGENT_FILE)) {
    try {
      const raw = JSON.parse(readFileSync(LEGACY_AGENT_FILE, 'utf8')) as {
        clientId?: string;
        clientSecret?: string;
        name?: string;
        createdAt?: string;
        apiUrl?: string;
      };
      if (typeof raw.clientId === 'string' && typeof raw.clientSecret === 'string') {
        store.agents.default = {
          apiUrl: raw.apiUrl ?? resolveApiUrlFromEnv(),
          clientId: raw.clientId,
          clientSecret: raw.clientSecret,
          name: raw.name,
          createdAt: raw.createdAt,
        };
        store.defaults.agent = 'default';
      }
    } catch {
      // Ignore malformed legacy file.
    }
  }

  if (Object.keys(store.humans).length === 0 && Object.keys(store.agents).length === 0) {
    return null;
  }

  atomicWriteStore(store);
  process.stderr.write(
    'bkey: migrated ~/.bkey/{config,agent}.json → ~/.bkey/profiles.json (default profiles)\n',
  );
  return store;
}

function resolveApiUrlFromEnv(): string {
  return (process.env.BKEY_BASE_URL || 'https://api.bkey.id').replace(/\/$/, '');
}

let cached: ProfilesStore | null = null;

export function loadStore(): ProfilesStore {
  if (cached) return cached;

  const fromDisk = readStoreFile(STORE_FILE);
  if (fromDisk) {
    cached = fromDisk;
    return fromDisk;
  }

  // Try backup — preferable to silently losing everything on a bad write.
  const fromBackup = readStoreFile(STORE_BACKUP);
  if (fromBackup) {
    process.stderr.write(
      `warning: ${STORE_FILE} unreadable; recovered from ${STORE_BACKUP}\n`,
    );
    cached = fromBackup;
    return fromBackup;
  }

  // One-time migration from 0.3.0 layout.
  const migrated = migrateLegacy();
  if (migrated) {
    cached = migrated;
    return migrated;
  }

  cached = emptyStore();
  return cached;
}

export function saveStore(store: ProfilesStore): void {
  validateStore(store);
  atomicWriteStore(store);
  cached = store;
}

/** Drop the in-memory cache; callers that mutate outside `saveStore` need this. */
export function invalidateStoreCache(): void {
  cached = null;
}

// ─── profile accessors ──────────────────────────────────────────────

export function listProfiles(principal: Principal): string[] {
  const store = loadStore();
  return Object.keys(principal === 'human' ? store.humans : store.agents).sort();
}

export function getProfile(principal: Principal, name: string): HumanProfile | AgentProfile | null {
  const store = loadStore();
  const bag = principal === 'human' ? store.humans : store.agents;
  return bag[name] ?? null;
}

export function getDefaultProfileName(principal: Principal): string | undefined {
  return loadStore().defaults[principal];
}

export function setDefaultProfileName(principal: Principal, name: string): void {
  const store = loadStore();
  const bag = principal === 'human' ? store.humans : store.agents;
  if (!bag[name]) {
    throw new Error(`No ${principal} profile named "${name}". Available: ${Object.keys(bag).join(', ') || '(none)'}`);
  }
  const next: ProfilesStore = {
    ...store,
    defaults: { ...store.defaults, [principal]: name },
  };
  saveStore(next);
}

export function saveHumanProfile(name: string, profile: HumanProfile): void {
  const store = loadStore();
  const next: ProfilesStore = {
    ...store,
    humans: { ...store.humans, [name]: profile },
    defaults: {
      ...store.defaults,
      human: store.defaults.human ?? name,
    },
  };
  saveStore(next);
}

export function saveAgentProfile(name: string, profile: AgentProfile): void {
  const store = loadStore();
  const next: ProfilesStore = {
    ...store,
    agents: { ...store.agents, [name]: profile },
    defaults: {
      ...store.defaults,
      agent: store.defaults.agent ?? name,
    },
  };
  saveStore(next);
}

export function deleteProfile(principal: Principal, name: string): boolean {
  const store = loadStore();

  if (principal === 'human') {
    if (!store.humans[name]) return false;
    const humans = { ...store.humans };
    delete humans[name];
    const nextDefaults = { ...store.defaults };
    if (nextDefaults.human === name) nextDefaults.human = Object.keys(humans)[0];
    saveStore({ ...store, humans, defaults: nextDefaults });
    return true;
  }

  if (!store.agents[name]) return false;
  const agents = { ...store.agents };
  delete agents[name];
  const nextDefaults = { ...store.defaults };
  if (nextDefaults.agent === name) nextDefaults.agent = Object.keys(agents)[0];
  saveStore({ ...store, agents, defaults: nextDefaults });
  return true;
}

export function renameProfile(principal: Principal, oldName: string, newName: string): void {
  if (oldName === newName) return;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(newName)) {
    throw new Error(`Invalid profile name "${newName}". Use letters, digits, dashes, underscores; max 48 chars; must start alphanumerically.`);
  }

  const store = loadStore();

  if (principal === 'human') {
    if (!store.humans[oldName]) throw new Error(`No human profile named "${oldName}".`);
    if (store.humans[newName]) throw new Error(`A human profile named "${newName}" already exists.`);
    const humans = { ...store.humans, [newName]: store.humans[oldName]! };
    delete humans[oldName];
    const nextDefaults = { ...store.defaults };
    if (nextDefaults.human === oldName) nextDefaults.human = newName;
    saveStore({ ...store, humans, defaults: nextDefaults });
    return;
  }

  if (!store.agents[oldName]) throw new Error(`No agent profile named "${oldName}".`);
  if (store.agents[newName]) throw new Error(`An agent profile named "${newName}" already exists.`);
  const agents = { ...store.agents, [newName]: store.agents[oldName]! };
  delete agents[oldName];
  const nextDefaults = { ...store.defaults };
  if (nextDefaults.agent === oldName) nextDefaults.agent = newName;
  saveStore({ ...store, agents, defaults: nextDefaults });
}

/** For `bkey auth logout` — remove legacy single-principal files. */
export function removeLegacyFiles(): void {
  for (const f of [LEGACY_CONFIG_FILE, LEGACY_AGENT_FILE]) {
    if (existsSync(f)) {
      try {
        unlinkSync(f);
      } catch {
        // Non-critical.
      }
    }
  }
}

/** Used by the status command to inspect the on-disk store path. */
export const STORE_PATHS = {
  configDir: CONFIG_DIR,
  store: STORE_FILE,
  backup: STORE_BACKUP,
  legacyHuman: LEGACY_CONFIG_FILE,
  legacyAgent: LEGACY_AGENT_FILE,
};

/** Diagnostics used by `profiles list`. */
export function storeStat(path: string): { exists: boolean; mode?: string; size?: number } {
  if (!existsSync(path)) return { exists: false };
  try {
    const s = statSync(path);
    return { exists: true, mode: (s.mode & 0o777).toString(8).padStart(3, '0'), size: s.size };
  } catch {
    return { exists: false };
  }
}
