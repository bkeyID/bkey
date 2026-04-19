// copyright © 2025-2026 bkey inc. all rights reserved.

import { Command } from 'commander';
import {
  deleteHumanProfile,
  deleteAgentProfile,
  getDefaultProfileName,
  listProfiles,
  renameProfile,
  resolveProfileName,
  setDefaultProfileName,
  STORE_PATHS,
  storeStat,
} from '../lib/config.js';
import { getProfile } from '../lib/profiles.js';

export const profilesCommand = new Command('profiles')
  .description('Manage BKey CLI profiles (humans and agents)');

// Run `bkey profiles` with no subcommand → `list`.
profilesCommand
  .action(() => runList({}));

// ─── list ──────────────────────────────────────────────────────────

profilesCommand
  .command('list', { isDefault: false })
  .alias('ls')
  .description('List all profiles with their type and default status')
  .option('--agent', 'Only show agent profiles')
  .option('--human', 'Only show human profiles')
  .option('--json', 'Emit as JSON (for scripting)')
  .action((opts: { agent?: boolean; human?: boolean; json?: boolean }) => runList(opts));

// ─── current ───────────────────────────────────────────────────────

profilesCommand
  .command('current')
  .description('Show the profile(s) that would be selected for the current environment')
  .option('--json', 'Emit as JSON')
  .action((opts: { json?: boolean }) => {
    const humanDefault = getDefaultProfileName('human');
    const agentDefault = getDefaultProfileName('agent');
    const envProfile = process.env.BKEY_PROFILE?.trim();
    const envMode = process.env.BKEY_MODE?.trim().toLowerCase();

    const humanResolved = resolveProfileName('human');
    const agentResolved = resolveProfileName('agent');

    if (opts.json) {
      process.stdout.write(JSON.stringify({
        defaults: { human: humanDefault, agent: agentDefault },
        resolved: { human: humanResolved, agent: agentResolved },
        env: {
          BKEY_PROFILE: envProfile ?? null,
          BKEY_MODE: envMode ?? null,
          BKEY_CLIENT_ID: process.env.BKEY_CLIENT_ID ? 'set' : null,
          BKEY_ACCESS_TOKEN: process.env.BKEY_ACCESS_TOKEN ? 'set' : null,
        },
      }, null, 2) + '\n');
      return;
    }

    console.log(`Human default: ${humanDefault ?? '(none)'}`);
    console.log(`Agent default: ${agentDefault ?? '(none)'}`);
    if (envProfile) console.log(`BKEY_PROFILE=${envProfile} (overrides both defaults)`);
    if (envMode) console.log(`BKEY_MODE=${envMode}`);
    if (process.env.BKEY_CLIENT_ID) {
      console.log('BKEY_CLIENT_ID set in env (direct agent creds override profiles)');
    }
  });

// ─── use ───────────────────────────────────────────────────────────

profilesCommand
  .command('use <name>')
  .description('Set the default profile for a principal')
  .option('--agent', 'Set default agent profile')
  .option('--human', 'Set default human profile (default)')
  .action((name: string, opts: { agent?: boolean; human?: boolean }) => {
    const principal: 'human' | 'agent' = opts.agent ? 'agent' : 'human';
    try {
      setDefaultProfileName(principal, name);
      console.log(`Default ${principal} profile set to "${name}".`);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

// ─── rename ────────────────────────────────────────────────────────

profilesCommand
  .command('rename <old> <new>')
  .description('Rename a profile')
  .option('--agent', 'Rename an agent profile')
  .option('--human', 'Rename a human profile (default)')
  .action((oldName: string, newName: string, opts: { agent?: boolean; human?: boolean }) => {
    const principal: 'human' | 'agent' = opts.agent ? 'agent' : 'human';
    try {
      renameProfile(principal, oldName, newName);
      console.log(`Renamed ${principal} profile "${oldName}" → "${newName}".`);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

// ─── delete ────────────────────────────────────────────────────────

profilesCommand
  .command('delete <name>')
  .alias('rm')
  .description('Delete a profile (no token revocation — use `bkey auth logout --profile <name>` for that)')
  .option('--agent', 'Delete an agent profile')
  .option('--human', 'Delete a human profile (default)')
  .action((name: string, opts: { agent?: boolean; human?: boolean }) => {
    const principal: 'human' | 'agent' = opts.agent ? 'agent' : 'human';
    const wasDefault = getDefaultProfileName(principal) === name;
    const ok = principal === 'human'
      ? deleteHumanProfile(name)
      : deleteAgentProfile(name);
    if (!ok) {
      console.error(`No ${principal} profile named "${name}".`);
      process.exit(1);
    }
    console.log(`Deleted ${principal} profile "${name}".`);
    if (wasDefault) {
      const remaining = listProfiles(principal);
      if (remaining.length > 0) {
        console.log(`New default ${principal} profile: "${remaining[0]}".`);
      } else {
        console.log(`No ${principal} profiles remain.`);
      }
    }
  });

// ─── list implementation ───────────────────────────────────────────

function runList(opts: { agent?: boolean; human?: boolean; json?: boolean }): void {
  const showHuman = !opts.agent;
  const showAgent = !opts.human;

  const humans = showHuman ? listProfiles('human').map((n) => describe('human', n)) : [];
  const agents = showAgent ? listProfiles('agent').map((n) => describe('agent', n)) : [];
  const store = storeStat(STORE_PATHS.store);

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      store: { path: STORE_PATHS.store, exists: store.exists, mode: store.mode, size: store.size },
      defaults: { human: getDefaultProfileName('human'), agent: getDefaultProfileName('agent') },
      humans,
      agents,
    }, null, 2) + '\n');
    return;
  }

  if (humans.length === 0 && agents.length === 0) {
    console.log('No profiles yet.');
    console.log('  bkey auth login                 — create a human profile');
    console.log('  bkey auth setup-agent --save    — create an agent profile');
    return;
  }

  const rows = [...humans, ...agents];
  const width = {
    type: Math.max(4, ...rows.map((r) => r.type.length)),
    name: Math.max(4, ...rows.map((r) => r.name.length)),
    display: Math.max(7, ...rows.map((r) => (r.display ?? '—').length)),
    api: Math.max(7, ...rows.map((r) => r.apiUrl.length)),
    note: Math.max(10, ...rows.map((r) => r.note.length)),
  };

  const header =
    `  ${pad('TYPE', width.type)}  ${pad('NAME', width.name)}  ${pad('DEFAULT', 7)}  ` +
    `${pad('DISPLAY', width.display)}  ${pad('API URL', width.api)}  NOTES`;
  console.log(header);

  for (const r of rows) {
    const marker = r.isDefault ? '    ✓  ' : '       ';
    const line =
      `  ${pad(r.type, width.type)}  ${pad(r.name, width.name)}  ${marker}` +
      `${pad(r.display ?? '—', width.display)}  ${pad(r.apiUrl, width.api)}  ${r.note}`;
    console.log(line);
  }

  console.log('');
  console.log(`Store: ${STORE_PATHS.store} (${store.exists ? `mode ${store.mode}, ${store.size} bytes` : 'missing'})`);
}

interface ProfileRow {
  type: 'human' | 'agent';
  name: string;
  display?: string;
  apiUrl: string;
  note: string;
  isDefault: boolean;
}

function describe(type: 'human' | 'agent', name: string): ProfileRow {
  const p = getProfile(type, name);
  if (!p) {
    return { type, name, apiUrl: '(missing)', note: 'unreadable', isDefault: false };
  }
  const isDefault = getDefaultProfileName(type) === name;
  if (type === 'human') {
    const h = p as { apiUrl: string; did?: string; tokenExpiresAt?: string };
    const expiresNote = h.tokenExpiresAt
      ? (new Date(h.tokenExpiresAt) < new Date() ? `expired ${h.tokenExpiresAt}` : `expires ${h.tokenExpiresAt}`)
      : 'no expiry';
    return {
      type,
      name,
      display: h.did ? shortDid(h.did) : undefined,
      apiUrl: h.apiUrl,
      note: expiresNote,
      isDefault,
    };
  }
  const a = p as { apiUrl: string; name?: string; createdAt?: string };
  return {
    type,
    name,
    display: a.name,
    apiUrl: a.apiUrl,
    note: a.createdAt ? `created ${a.createdAt}` : '',
    isDefault,
  };
}

function shortDid(did: string): string {
  if (did.length <= 32) return did;
  return `${did.slice(0, 16)}…${did.slice(-8)}`;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}
