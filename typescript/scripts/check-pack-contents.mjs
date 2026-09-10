#!/usr/bin/env node
/**
 * Published-tarball contents gate.
 *
 * `@bkey/sdk` shipped its own unit tests to npm. Its tsconfig declared
 * `include: ["src/**\/*.ts"]` but — unlike `@bkey/node` and `@bkey/login` —
 * no matching `exclude`, so `tsc` emitted `dist/client.test.js` from
 * `src/client.test.ts`, and `files: ["dist"]` swept it into the tarball. The
 * emitted JS still imported `vitest`, a devDependency consumers do not have.
 *
 * The same stray build output also fed back into the test run: vitest's
 * default exclude covers `node_modules` but not `dist`, so `pnpm test`
 * collected both `src/client.test.ts` and `dist/client.test.js` and reported
 * 18 passing tests for 9 unique ones. A duplicated suite inflates the count
 * without adding coverage, and hides the leak behind a greener number.
 *
 * Adding the missing `exclude` fixes today's leak; this script fixes the
 * mechanism. On every CI run, for each published (non-private) workspace
 * package, it asks npm exactly what the tarball would contain and fails if any
 * entry looks like a test artifact. A new package that forgets `exclude`, or a
 * tsconfig edit that drops it, goes red here instead of on npm.
 *
 * It fails closed: a package whose contents cannot be determined is an error,
 * never a pass.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES_DIR = join(TS_ROOT, 'packages');

/**
 * Matches a path segment that is a test artifact in any of the shapes this
 * repo's toolchains produce: `foo.test.ts`, the `.js`/`.d.ts`/`.js.map` files
 * `tsc` emits from it, `.spec.` variants, and `__tests__/` directories.
 */
const TEST_ARTIFACT = /(^|\/)(__tests__\/|[^/]*\.(test|spec)\.)/;

const errors = [];

/** Read and parse a package.json, failing closed on anything unreadable. */
function readManifest(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read ${path}: ${err.message}`);
  }
}

/**
 * Ask npm what `npm publish` would put in the tarball. `--dry-run` packs
 * nothing and writes nothing; `--json` gives the file list on stdout.
 */
function tarballFiles(pkgDir, pkgName) {
  let raw;
  try {
    raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: pkgDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    throw new Error(`npm pack failed for ${pkgName}: ${err.stderr || err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`npm pack produced unparseable JSON for ${pkgName}`);
  }

  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!entry || !Array.isArray(entry.files)) {
    throw new Error(`npm pack reported no file list for ${pkgName}`);
  }
  return entry.files.map((f) => f.path);
}

if (!existsSync(PACKAGES_DIR)) {
  console.error(`error: no packages directory at ${PACKAGES_DIR}`);
  process.exit(1);
}

const dirs = readdirSync(PACKAGES_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

let checked = 0;

for (const dir of dirs) {
  const pkgDir = join(PACKAGES_DIR, dir);
  const manifestPath = join(pkgDir, 'package.json');
  if (!existsSync(manifestPath)) continue;

  let manifest;
  try {
    manifest = readManifest(manifestPath);
  } catch (err) {
    errors.push(err.message);
    continue;
  }

  // Private packages are never published, so their contents cannot leak.
  if (manifest.private === true) continue;

  const name = manifest.name || `packages/${dir}`;

  let files;
  try {
    files = tarballFiles(pkgDir, name);
  } catch (err) {
    errors.push(err.message);
    continue;
  }

  checked += 1;

  const leaked = files.filter((f) => TEST_ARTIFACT.test(f));
  if (leaked.length > 0) {
    errors.push(
      `${name} would publish ${leaked.length} test artifact(s):\n` +
        leaked.map((f) => `      ${f}`).join('\n') +
        `\n    Fix: add "exclude": ["src/**/*.test.ts"] to packages/${dir}/tsconfig.json` +
        `\n    (or narrow "files" in packages/${dir}/package.json).`,
    );
  } else {
    console.log(`ok  ${name} — ${files.length} files, no test artifacts`);
  }
}

if (checked === 0) {
  console.error('error: no published packages were checked — refusing to pass vacuously');
  process.exit(1);
}

if (errors.length > 0) {
  console.error('\nPublished-tarball contents gate failed:\n');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(`\n${checked} published package(s) checked — no test artifacts in any tarball`);
