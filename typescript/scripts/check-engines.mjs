#!/usr/bin/env node
/**
 * Engine-floor drift gate.
 *
 * The repo silently took a Node 22 floor once already: a dependabot bump moved
 * `commander` to 15 (engines `>=22.12.0`) inside `@bkey/cli`, which declared no
 * engines at all, while CI kept building on Node 20. Nothing went red, and the
 * next release would have shipped a Node-22 dependency to Node 20 installers
 * with only a bare transitive EBADENGINE warning to show for it.
 *
 * Declaring `engines` fixes the symptom; this script fixes the mechanism. It
 * asserts, on every CI run:
 *
 *   1. Every published (non-private) workspace package declares `engines.node`.
 *   2. Each declared floor is at least as high as the floor of every dependency
 *      that declares its own `engines.node` — so a dep bump that raises the real
 *      floor fails here instead of at a user's install.
 *   3. Workspace dependencies do not out-floor their dependents.
 *   4. The Node running this script satisfies every declared floor — so a green
 *      CI actually exercises the versions we claim to support.
 *
 * It fails closed: any range shape it cannot parse is an error, never a pass.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES_DIR = join(TS_ROOT, 'packages');

const errors = [];
const notes = [];

// ---------------------------------------------------------------------------
// Minimal semver. Deliberately not the `semver` package: this runs before the
// build in CI, and a drift gate that needs its own dependency graph installed
// is a gate that can be skipped. Only the comparator forms that appear in real
// `engines` fields are supported; anything else throws.
// ---------------------------------------------------------------------------

/** Parse "20", "14.13", "20.19.0", "22.12.0-rc.1" into [major, minor, patch]. */
function parseVersion(raw, context) {
  const core = String(raw).trim().split(/[-+]/)[0];
  const parts = core.split('.');
  if (parts.length === 0 || parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) {
    throw new Error(`${context}: cannot parse version "${raw}"`);
  }
  while (parts.length < 3) parts.push('0');
  return parts.map(Number);
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/** Does concrete version `v` satisfy a single comparator like ">=20.19.0"? */
function satisfiesComparator(v, comparator, context) {
  if (comparator === '*' || comparator === '') return true;

  const m = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(comparator);
  if (!m) throw new Error(`${context}: cannot parse comparator "${comparator}"`);
  const [, op = '=', versionText] = m;
  if (/[x*]/i.test(versionText)) {
    throw new Error(`${context}: wildcard ranges are not supported ("${comparator}")`);
  }
  const target = parseVersion(versionText, context);
  const cmp = compare(v, target);

  switch (op) {
    case '>=': return cmp >= 0;
    case '>':  return cmp > 0;
    case '<=': return cmp <= 0;
    case '<':  return cmp < 0;
    case '=':  return cmp === 0;
    // ^1.2.3 => >=1.2.3 <2.0.0 ; ^0.2.3 => >=0.2.3 <0.3.0
    case '^': {
      if (cmp < 0) return false;
      const upper = target[0] > 0
        ? [target[0] + 1, 0, 0]
        : [0, target[1] + 1, 0];
      return compare(v, upper) < 0;
    }
    // ~1.2.3 => >=1.2.3 <1.3.0
    case '~': {
      if (cmp < 0) return false;
      return compare(v, [target[0], target[1] + 1, 0]) < 0;
    }
    default:
      throw new Error(`${context}: unsupported operator "${op}"`);
  }
}

/**
 * Does concrete version `v` satisfy `range`? Handles "||" alternatives and
 * whitespace-joined comparator sets, e.g. "^12.17.0||^14.13||>=16.0.0" and
 * ">= 20.19.0" (@noble/curves writes it with a space).
 */
function satisfies(v, range, context) {
  const normalized = String(range).replace(/([<>=~^]+)\s+/g, '$1').trim();
  return normalized.split('||').some((alternative) =>
    alternative
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean)
      .every((comparator) => satisfiesComparator(v, comparator, context)),
  );
}

/**
 * Our own floors must stay a plain ">=X.Y.Z". A range like "^22" would let a
 * future major silently fall out of support, and check 2 below reasons about a
 * single lowest supported version.
 */
function declaredFloor(range, context) {
  const m = /^>=\s*(\d+\.\d+\.\d+)$/.exec(String(range).trim());
  if (!m) {
    throw new Error(
      `${context}: engines.node must be a plain ">=X.Y.Z" floor, got "${range}"`,
    );
  }
  return parseVersion(m[1], context);
}

const show = (v) => v.join('.');

// ---------------------------------------------------------------------------
// Resolve an installed dependency's package.json by walking up node_modules.
// pnpm symlinks direct dependencies into <package>/node_modules/<name>, so the
// first hit is the version this package actually resolves.
// ---------------------------------------------------------------------------
function readInstalledManifest(fromDir, depName) {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, 'node_modules', depName, 'package.json');
    if (existsSync(candidate)) {
      return { manifest: JSON.parse(readFileSync(candidate, 'utf8')), path: candidate };
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// ---------------------------------------------------------------------------

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

const workspace = readdirSync(PACKAGES_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => {
    const dir = join(PACKAGES_DIR, e.name);
    return { dir, manifest: readJson(join(dir, 'package.json')) };
  })
  .filter((p) => p.manifest.name);

if (workspace.length === 0) {
  console.error('check-engines: no workspace packages found under packages/');
  process.exit(1);
}

const floors = new Map(); // package name -> [major, minor, patch]

// --- 1. every published package declares a floor --------------------------
for (const { manifest } of workspace) {
  const declared = manifest.engines?.node;
  if (!declared) {
    if (manifest.private) continue;
    errors.push(
      `${manifest.name}: published package declares no engines.node. ` +
        `npm then gives installers no signal about the runtime it needs.`,
    );
    continue;
  }
  try {
    floors.set(manifest.name, declaredFloor(declared, manifest.name));
  } catch (err) {
    errors.push(err.message);
  }
}

// --- 2 & 3. floors must cover every dependency's own floor ----------------
for (const { dir, manifest } of workspace) {
  const floor = floors.get(manifest.name);
  if (!floor) continue;

  for (const [depName, specifier] of Object.entries(manifest.dependencies ?? {})) {
    // Workspace siblings: compare declared floors directly (check 3).
    if (String(specifier).startsWith('workspace:')) {
      const siblingFloor = floors.get(depName);
      if (siblingFloor && compare(floor, siblingFloor) < 0) {
        errors.push(
          `${manifest.name} declares node >=${show(floor)} but depends on workspace ` +
            `${depName}, which declares >=${show(siblingFloor)}.`,
        );
      }
      continue;
    }

    const found = readInstalledManifest(dir, depName);
    if (!found) {
      errors.push(
        `${manifest.name}: dependency ${depName} is not installed — run ` +
          `\`pnpm install\` before this check.`,
      );
      continue;
    }

    const depRange = found.manifest.engines?.node;
    if (!depRange) continue;

    let ok;
    try {
      ok = satisfies(floor, depRange, `${manifest.name} -> ${depName}`);
    } catch (err) {
      errors.push(err.message);
      continue;
    }

    if (!ok) {
      errors.push(
        `${manifest.name} declares node >=${show(floor)}, but ${depName}@` +
          `${found.manifest.version} requires "${depRange}". Either raise ` +
          `${manifest.name}'s engines.node or pin ${depName} back.`,
      );
    } else {
      notes.push(
        `  ${manifest.name} >=${show(floor)}  ⊇  ${depName}@${found.manifest.version} "${depRange}"`,
      );
    }
  }
}

// --- 4. the Node running CI must satisfy every declared floor -------------
const running = parseVersion(process.versions.node, 'process.version');
for (const [name, floor] of floors) {
  if (compare(running, floor) < 0) {
    errors.push(
      `CI runs Node ${show(running)}, below ${name}'s declared floor ` +
        `>=${show(floor)}. A green run on this Node proves nothing about that floor.`,
    );
  }
}

// ---------------------------------------------------------------------------

if (notes.length > 0) {
  console.log('check-engines: dependency floors covered');
  for (const n of notes) console.log(n);
}

if (errors.length > 0) {
  console.error(`\ncheck-engines: ${errors.length} problem(s)\n`);
  for (const e of errors) console.error(`  ✗ ${e}`);
  console.error('');
  process.exit(1);
}

const summary = [...floors]
  .map(([name, floor]) => `${name} >=${show(floor)}`)
  .sort()
  .join(', ');
console.log(`check-engines: OK on Node ${show(running)} — ${summary}`);
