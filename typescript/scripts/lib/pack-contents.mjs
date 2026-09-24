/**
 * Pure helpers for the published-tarball contents gate.
 *
 * Kept separate from `scripts/check-pack-contents.mjs` so the matcher can be
 * unit-tested on its own, without `npm pack` or a built `dist/` in the way.
 * The predecessor of this gate shipped with a regex nobody had exercised: it
 * matched `dist/client.test.js` and nothing else it claimed to match, and it
 * flagged a legitimate `dist/openapi.spec.json`. See `pack-contents.test.mjs`.
 */

/**
 * Extensions a test module (or a `tsc` artifact derived from one) can have.
 * Covers JS and TS in every module flavour, the `.d.ts` declarations, and the
 * `.map` sidecars.
 *
 * The classifier below requires one of these before flagging a `.test.` /
 * `.spec.` / `.test-d.` / `.spec-d.` basename or a file under `spec/`. That is
 * the whole point of the check: the harm this gate exists to prevent is
 * publishing an executable module that imports a devDependency
 * (`@bkey/sdk@0.2.0` shipped `dist/client.test.js`, whose second line is
 * `import ... from 'vitest'`) and that vitest then collects as a second copy
 * of a suite. A `.json` fixture can do neither.
 */
const CODE_FILE = /\.(?:[cm]?jsx?|[cm]?tsx?|map)$/i;

/**
 * Directory names that only ever hold test scaffolding. `__mocks__` is jest's
 * and vitest's convention for manual module mocks; like the others, nothing a
 * package publishes belongs under it.
 */
const TEST_DIRS = new Set(['test', 'tests', '__test__', '__tests__', '__mocks__']);

/**
 * Directory names that usually hold test scaffolding but sometimes hold a
 * published API specification (`dist/spec/openapi.json`), so the extension
 * decides.
 */
const SPEC_DIRS = new Set(['spec', 'specs', '__spec__', '__specs__']);

/**
 * `client.test.js`, `client.spec.ts`, `client.TEST.js.map`, and the `-d`
 * type-test variants `client.test-d.ts` / `client.spec-d.js`.
 *
 * The `-d` arm matters because `*.test-d.ts` is vitest's own default naming
 * convention for type tests (`typecheck.include` defaults to
 * `**\/*.test-d.?(c|m)[jt]s?(x)`), and a `tsconfig.json` excluding only
 * `src/**\/*.test.ts` does not match it — so `tsc` emits `client.test-d.js`,
 * `client.test-d.d.ts` and `client.test-d.js.map` straight into `dist/`.
 * `-d` must be followed by the extension dot, so `client.test-data.js` is not
 * a match.
 */
const TEST_BASENAME = /\.(?:test|spec)(?:-d)?\./i;

/**
 * Classify one tarball entry path (POSIX, relative to the package root, as
 * `npm pack --json` reports it).
 *
 * Returns `null` for anything a package may legitimately publish, or
 * `{ path, rule }` naming the rule that flagged it. The rules, in order:
 *
 *   1. `test-dir`  — a directory segment named `test`, `tests`, `__test__`,
 *      `__tests__` or `__mocks__` (case-insensitive), whatever the file's
 *      extension. Nothing a package publishes belongs under a directory with
 *      one of those names.
 *   2. `spec-dir`  — a directory segment named `spec`, `specs`, `__spec__` or
 *      `__specs__` (case-insensitive), for code files only.
 *   3. `test-file` — a basename containing `.test.`, `.spec.`, `.test-d.` or
 *      `.spec-d.` (case-insensitive), for code files only. These are the
 *      shapes `tsc` emits from `src/*.test.ts` and `src/*.test-d.ts`: `.js`,
 *      `.d.ts`, `.js.map`, `.d.ts.map`.
 *
 * Deliberately NOT covered, and not claimed anywhere: separator variants such
 * as `client-test.js` and `client_test.js`, and prefix-only variants such as
 * `client.test-data.js`, where `-d` is not followed by the extension dot. No
 * toolchain in this repo emits them from a `*.test.ts` or `*.test-d.ts`
 * source, and they are as likely to be a legitimate module name as a leak.
 * Nor are non-code files outside a `test/` directory — see CODE_FILE above.
 */
export function classifyEntry(path) {
  if (typeof path !== 'string' || path === '') {
    throw new TypeError(`classifyEntry expects a non-empty string, got ${JSON.stringify(path)}`);
  }

  const segments = path.split('/');
  const basename = segments[segments.length - 1];
  const dirs = segments.slice(0, -1).map((s) => s.toLowerCase());
  const isCode = CODE_FILE.test(basename);

  if (dirs.some((d) => TEST_DIRS.has(d))) return { path, rule: 'test-dir' };
  if (isCode && dirs.some((d) => SPEC_DIRS.has(d))) return { path, rule: 'spec-dir' };
  if (isCode && TEST_BASENAME.test(basename)) return { path, rule: 'test-file' };
  return null;
}

/** Every entry in `paths` that `classifyEntry` flags, in input order. */
export function findTestArtifacts(paths) {
  return paths.map((p) => classifyEntry(p)).filter((hit) => hit !== null);
}

/** Human-readable reason, used in the gate's failure output. */
export const RULE_DESCRIPTIONS = {
  'test-dir': 'lives under a test/ or __mocks__/ directory',
  'spec-dir': 'code file under a spec/ directory',
  'test-file': '.test. / .spec. / .test-d. / .spec-d. module',
};

/**
 * A module that can execute, and therefore can import a devDependency the
 * consumer has not installed. Used for the "this tarball has no code at all"
 * check, which is how the predecessor gate passed on an empty `dist/`.
 */
const JS_MODULE = /\.[cm]?js$/i;

/** Does this tarball contain at least one runnable JavaScript module? */
export function hasJsModule(paths) {
  return paths.some((p) => JS_MODULE.test(p));
}

/**
 * Pull the file list out of `npm pack --dry-run --json` output, validating
 * every assumption instead of letting a shape change degrade into a pass.
 *
 * The predecessor did `entry.files.map((f) => f.path)`. An entry without a
 * `path` became `undefined`, `regex.test(undefined)` stringified it to
 * `"undefined"`, no rule matched, and the package scored clean.
 */
export function tarballFilePaths(raw, pkgName) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`npm pack produced unparseable JSON for ${pkgName}: ${err.message}`);
  }

  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!entry || typeof entry !== 'object') {
    throw new Error(`npm pack reported no tarball for ${pkgName}`);
  }
  if (!Array.isArray(entry.files)) {
    throw new Error(`npm pack reported no file list for ${pkgName}`);
  }

  const paths = entry.files.map((f, i) => {
    if (!f || typeof f.path !== 'string' || f.path === '') {
      throw new Error(
        `npm pack reported file[${i}] without a usable "path" for ${pkgName} ` +
          `(got ${JSON.stringify(f)}). Refusing to scan a file list this gate ` +
          `cannot read.`,
      );
    }
    return f.path;
  });

  if (typeof entry.entryCount === 'number' && entry.entryCount !== paths.length) {
    throw new Error(
      `npm pack reported entryCount ${entry.entryCount} for ${pkgName} but ` +
        `listed ${paths.length} file(s) — the file list is incomplete.`,
    );
  }

  if (paths.length === 0) {
    throw new Error(`${pkgName} would publish an empty tarball`);
  }

  return paths;
}

/** Strip a leading `./` so manifest paths compare against tarball paths. */
function normalizeEntryPoint(value) {
  return value.replace(/^\.\//, '');
}

/** Collect every string leaf under an `exports` subtree. */
function exportTargets(node, out) {
  if (typeof node === 'string') {
    out.push(node);
  } else if (Array.isArray(node)) {
    for (const v of node) exportTargets(v, out);
  } else if (node && typeof node === 'object') {
    for (const v of Object.values(node)) exportTargets(v, out);
  }
  return out;
}

/**
 * Every in-package file the manifest promises consumers: `main`, `module`,
 * `types`/`typings`, `browser`, `bin`, and the string leaves of `exports`.
 *
 * This is what makes the gate non-vacuous per package. Moving `dist/` aside
 * and re-running the predecessor printed `ok @bkey/sdk — 1 files, no test
 * artifacts` and exited 0, because a tarball of nothing but `package.json`
 * contains no test artifacts either. A package that does not ship the files
 * its own manifest points at is broken, whatever else the tarball holds.
 *
 * Subpath patterns (`"./*": "./dist/*.js"`) are skipped: there is no single
 * file to look for. Anything outside the package is skipped too.
 */
export function declaredEntryPoints(manifest) {
  const raw = [];
  for (const field of ['main', 'module', 'types', 'typings', 'browser']) {
    if (typeof manifest[field] === 'string') raw.push(manifest[field]);
  }
  if (typeof manifest.bin === 'string') raw.push(manifest.bin);
  else if (manifest.bin && typeof manifest.bin === 'object') {
    for (const v of Object.values(manifest.bin)) if (typeof v === 'string') raw.push(v);
  }
  exportTargets(manifest.exports, raw);

  const seen = new Set();
  for (const value of raw) {
    if (value.includes('*')) continue;
    const normalized = normalizeEntryPoint(value);
    if (normalized === '' || normalized.startsWith('../') || normalized.startsWith('/')) continue;
    seen.add(normalized);
  }
  return [...seen].sort();
}

/**
 * A TypeScript source file that is a test, and therefore must be both kept out
 * of `dist/` and kept inside some program that typechecks it.
 *
 * Matches the `.test.` / `.spec.` / `.test-d.` / `.spec-d.` family of
 * `classifyEntry`'s rule 3, restricted to TypeScript: these are sources, not
 * emitted artifacts. `*.test-d.ts` is included because it is vitest's own
 * default naming convention for type tests, and because `vitest run` does not
 * typecheck those files any more than it typechecks `*.test.ts`:
 * `typecheck.include` applies only under `--typecheck`, which no package here
 * passes.
 */
const TEST_SOURCE = /\.(?:test|spec)(?:-d)?\.[cm]?tsx?$/i;

/** Is this basename a TypeScript test source? */
export function isTestSource(basename) {
  if (typeof basename !== 'string') return false;
  return TEST_SOURCE.test(basename);
}

/**
 * Every config path a package script passes to `tsc` via `-p` / `--project`.
 *
 * Check C used to accept any `typecheck` script whose text *contained*
 * `tsconfig.test.json`. `tsc -p tsconfig.json # tsconfig.test.json` satisfied
 * that substring test while typechecking nothing but the build program — npm
 * runs scripts through `sh`, which drops the comment before `tsc` ever sees
 * it. Reading the actual argument closes that hole.
 *
 * Everything from the first `#`-initial token on is treated as a shell comment
 * and ignored. A `#` inside quotes is not really a comment, but misreading one
 * can only hide a `-p`, which makes the gate fail rather than pass.
 */
export function typecheckProjects(script) {
  if (typeof script !== 'string') return [];

  const found = [];
  const tokens = script.split(/\s+/).filter(Boolean);

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.startsWith('#')) break;

    const inline = /^(?:-p|--project)=(.+)$/.exec(token);
    if (inline) {
      found.push(inline[1]);
      continue;
    }
    if (token === '-p' || token === '--project') {
      const value = tokens[i + 1];
      if (value !== undefined && !value.startsWith('-') && !value.startsWith('#')) {
        found.push(value);
        i += 1;
      }
    }
  }

  return found
    .map((v) => v.replace(/^["']|["']$/g, '').replace(/^\.\//, ''))
    .filter((v) => v !== '');
}
