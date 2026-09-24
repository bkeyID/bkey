#!/usr/bin/env node
/**
 * Test-file placement gate: tests must be typechecked, and must not be
 * published.
 *
 * `@bkey/sdk` shipped its own unit tests to npm. Its tsconfig declared
 * `include: ["src/**\/*.ts"]` but — unlike `@bkey/node` and `@bkey/login` — no
 * matching `exclude`, so `tsc` emitted `dist/client.test.js` from
 * `src/client.test.ts` and `files: ["dist", "README.md"]` swept it, its
 * declaration, and its source map into the tarball. The emitted JS still
 * imported `vitest`, which consumers do not install. It also fed back into the
 * test run: vitest's default exclude covers `node_modules` but not `dist`, so
 * `pnpm test` collected both copies of the suite and reported 18 passing tests
 * for 9 unique ones — a greener number for no extra coverage.
 *
 * Adding the missing `exclude` fixes today's leak. The exclude, however, also
 * removes the tests from the only program that typechecks them, so the two
 * halves have to be enforced together or fixing one silently breaks the other.
 * On every CI run, for each published (non-private) workspace package:
 *
 *   A. Tarball contents. Ask npm exactly what `npm publish` would send, and
 *      fail if any entry is a test artifact (see `lib/pack-contents.mjs` for
 *      the matcher and exactly what it does and does not cover).
 *   B. Tarball completeness. Fail unless the tarball actually contains every
 *      file the manifest promises (`main`, `types`, `exports`, `bin`) and at
 *      least one runnable JavaScript module.
 *   C. Typecheck coverage. Any package with test sources under `src/` — a
 *      `.test.`, `.spec.`, `.test-d.` or `.spec-d.` TypeScript basename — must
 *      have a `tsconfig.test.json` whose resolved program — as reported by
 *      `tsc --showConfig`, not by re-implementing tsc's globs — contains every
 *      one of those files, with `noEmit`, and a `typecheck` script that passes
 *      that config to `tsc -p`.
 *
 * Check B exists because the predecessor of this gate had none. Its `checked`
 * counter counted packages, not files, so with `packages/sdk/dist` moved aside
 * it printed `ok  @bkey/sdk — 1 files, no test artifacts` and exited 0: a
 * tarball holding nothing but `package.json` contains no test artifacts
 * either. It inspected real output only because CI happened to run it after
 * `pnpm build` — step ordering, not a property of the script.
 *
 * It fails closed. A package whose contents, manifest, or test program cannot
 * be determined is an error, never a pass.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  declaredEntryPoints,
  findTestArtifacts,
  hasJsModule,
  isTestSource,
  RULE_DESCRIPTIONS,
  tarballFilePaths,
  typecheckProjects,
} from './lib/pack-contents.mjs';

const TS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES_DIR = join(TS_ROOT, 'packages');

const errors = [];
const notes = [];

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read ${relative(TS_ROOT, path)}: ${err.message}`);
  }
};

/**
 * Ask npm what `npm publish` would put in the tarball. `--dry-run` packs
 * nothing and writes nothing; `--json` puts the file list on stdout.
 */
function packOutput(pkgDir, pkgName) {
  try {
    return execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: pkgDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    throw new Error(`npm pack failed for ${pkgName}: ${err.stderr || err.message}`);
  }
}

/** The workspace's own tsc. Never `npx`: a gate must not fetch a toolchain. */
function resolveTsc(pkgDir) {
  for (let dir = pkgDir; ; dir = dirname(dir)) {
    const bin = join(dir, 'node_modules', '.bin', 'tsc');
    if (existsSync(bin)) return bin;
    if (dirname(dir) === dir) break;
  }
  throw new Error('typescript is not installed — run `pnpm install` before this check');
}

/**
 * The files tsc itself resolves for a config, as POSIX paths relative to the
 * package. `--showConfig` reports the resolved program without compiling, so
 * this gate never has to guess how `include`/`exclude` globs expand.
 */
function resolvedProgram(pkgDir, configName, pkgName) {
  const tsc = resolveTsc(pkgDir);
  let raw;
  try {
    raw = execFileSync(tsc, ['--showConfig', '-p', configName], {
      cwd: pkgDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    throw new Error(
      `tsc --showConfig -p ${configName} failed for ${pkgName}: ${err.stderr || err.message}`,
    );
  }

  let config;
  try {
    config = JSON.parse(raw);
  } catch (err) {
    throw new Error(`tsc --showConfig emitted unparseable JSON for ${pkgName}: ${err.message}`);
  }
  if (!config || typeof config !== 'object' || !Array.isArray(config.files)) {
    throw new Error(
      `tsc --showConfig -p ${configName} reported no resolved file list for ${pkgName}`,
    );
  }

  return {
    files: new Set(
      config.files.map((f) => relative(pkgDir, resolve(pkgDir, f)).split(sep).join('/')),
    ),
    compilerOptions: config.compilerOptions ?? {},
  };
}

/**
 * Every TypeScript test source under a package's `src/`, as POSIX-relative
 * paths. `isTestSource` covers `.test.`, `.spec.`, `.test-d.` and `.spec-d.`;
 * a `*.test-d.ts` counts because `vitest run` typechecks it no more than it
 * typechecks a `*.test.ts` — `typecheck.include` applies only under
 * `--typecheck`, which no package here passes.
 */
function testSources(pkgDir) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && isTestSource(entry.name)) {
        found.push(relative(pkgDir, full).split(sep).join('/'));
      }
    }
  };
  const src = join(pkgDir, 'src');
  if (existsSync(src) && statSync(src).isDirectory()) walk(src);
  return found.sort();
}

// --- A + B: what each package would publish ---------------------------------

function checkTarball(pkgDir, dir, manifest, name) {
  const files = tarballFilePaths(packOutput(pkgDir, name), name);
  const present = new Set(files);

  const leaked = findTestArtifacts(files);
  if (leaked.length > 0) {
    errors.push(
      `${name} would publish ${leaked.length} test artifact(s):\n` +
        leaked
          .map((hit) => `      ${hit.path}  (${RULE_DESCRIPTIONS[hit.rule]})`)
          .join('\n') +
        `\n    Fix: widen "exclude" in packages/${dir}/tsconfig.json to cover the` +
        `\n    source that emitted them (the .test.ts / .spec.ts / .test-d.ts /` +
        `\n    .spec-d.ts family), keeping packages/${dir}/tsconfig.test.json as the` +
        `\n    program that still typechecks them (or narrow "files" in` +
        `\n    packages/${dir}/package.json).`,
    );
  }

  const declared = declaredEntryPoints(manifest);
  if (declared.length === 0) {
    errors.push(
      `${name} declares no main, exports, types or bin, so there is nothing to ` +
        `verify the tarball against. This gate will not report a package it ` +
        `cannot check as clean.`,
    );
  }

  const missing = declared.filter((f) => !present.has(f));
  if (missing.length > 0) {
    errors.push(
      `${name}'s tarball is missing ${missing.length} file(s) its own manifest ` +
        `points at:\n` +
        missing.map((f) => `      ${f}`).join('\n') +
        `\n    Run \`pnpm build\` before this check — an unbuilt dist/ has no test` +
        `\n    artifacts in it either, which is not the same as being clean.`,
    );
  }

  if (!hasJsModule(files)) {
    errors.push(
      `${name}'s tarball contains no JavaScript module at all (${files.length} ` +
        `entr${files.length === 1 ? 'y' : 'ies'}: ${files.join(', ')}). ` +
        `A published package with no code is either an unbuilt dist/ or a ` +
        `mispacked "files" list.`,
    );
  }

  return files;
}

// --- C: tests excluded from the build must still be typechecked -------------

function checkTypecheckCoverage(pkgDir, dir, manifest, name) {
  const tests = testSources(pkgDir);
  if (tests.length === 0) {
    notes.push(`  ${name} — no test sources, nothing to typecheck`);
    return;
  }

  const configName = 'tsconfig.test.json';
  if (!existsSync(join(pkgDir, configName))) {
    errors.push(
      `${name} has ${tests.length} test source(s) but no packages/${dir}/${configName}. ` +
        `The build tsconfig must keep them out of dist/, so nothing else ` +
        `typechecks them: \`vitest run\` executes tests without typechecking ` +
        `them, and its \`typecheck.include\` default (\`*.test-d.*\`) applies only ` +
        `under \`--typecheck\`, which no package here passes.`,
    );
    return;
  }

  const program = resolvedProgram(pkgDir, configName, name);
  const uncovered = tests.filter((f) => !program.files.has(f));
  if (uncovered.length > 0) {
    errors.push(
      `packages/${dir}/${configName} resolves to a program that leaves ` +
        `${uncovered.length} test source(s) untypechecked:\n` +
        uncovered.map((f) => `      ${f}`).join('\n') +
        `\n    Widen its "include" (and reset the build config's "exclude", which` +
        `\n    "extends" inherits).`,
    );
  }

  if (program.compilerOptions.noEmit !== true) {
    errors.push(
      `packages/${dir}/${configName} does not set "noEmit": true. A test config ` +
        `that emits puts the test files it typechecks back into dist/, which is ` +
        `the leak this gate exists to prevent.`,
    );
  }

  // Read the actual `-p` / `--project` argument, not any substring of the
  // script: `tsc -p tsconfig.json # tsconfig.test.json` mentions the config
  // without ever compiling it, and npm runs scripts through `sh`, which drops
  // the comment before `tsc` sees it.
  const script = manifest.scripts?.typecheck;
  if (!typecheckProjects(script).includes(configName)) {
    errors.push(
      `${name} needs a "typecheck" script that passes ${configName} to ` +
        `\`tsc -p\` (found ${script === undefined ? 'none' : JSON.stringify(script)}). ` +
        `\`pnpm typecheck\` in CI dispatches per package, so a package without ` +
        `the script is skipped silently.`,
    );
    return;
  }

  if (uncovered.length === 0) {
    notes.push(`  ${name} — ${tests.length} test source(s) typechecked by ${configName}`);
  }
}

// --- driver -----------------------------------------------------------------

if (!existsSync(PACKAGES_DIR)) {
  console.error(`check-pack-contents: no packages directory at ${PACKAGES_DIR}`);
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
    manifest = readJson(manifestPath);
  } catch (err) {
    errors.push(err.message);
    continue;
  }

  // Private packages are never published, so their contents cannot leak.
  if (manifest.private === true) continue;

  const name = manifest.name || `packages/${dir}`;
  checked += 1;

  let files;
  try {
    files = checkTarball(pkgDir, dir, manifest, name);
  } catch (err) {
    errors.push(err.message);
  }

  try {
    checkTypecheckCoverage(pkgDir, dir, manifest, name);
  } catch (err) {
    errors.push(err.message);
  }

  if (files) notes.push(`  ${name} — ${files.length} tarball entries, no test artifacts`);
}

if (checked === 0) {
  console.error(
    'check-pack-contents: no published packages were found under packages/ — ' +
      'refusing to pass vacuously',
  );
  process.exit(1);
}

if (notes.length > 0 && errors.length === 0) {
  console.log('check-pack-contents: tests are typechecked and unpublished');
  for (const n of notes) console.log(n);
}

if (errors.length > 0) {
  console.error(`\ncheck-pack-contents: ${errors.length} problem(s)\n`);
  for (const e of errors) console.error(`  ✗ ${e}`);
  console.error('');
  process.exit(1);
}

console.log(`\n${checked} published package(s) checked`);
