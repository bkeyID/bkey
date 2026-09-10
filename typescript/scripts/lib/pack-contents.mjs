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
 * `.spec.` basename or a file under `spec/`. That is the whole point of the
 * check: the harm this gate exists to prevent is publishing an executable
 * module that imports a devDependency (`@bkey/sdk@0.2.0` shipped
 * `dist/client.test.js`, whose second line is `import ... from 'vitest'`) and
 * that vitest then collects as a second copy of a suite. A `.json` fixture can
 * do neither.
 */
const CODE_FILE = /\.(?:[cm]?jsx?|[cm]?tsx?|map)$/i;

/** Directory names that only ever hold test scaffolding. */
const TEST_DIRS = new Set(['test', 'tests', '__test__', '__tests__']);

/**
 * Directory names that usually hold test scaffolding but sometimes hold a
 * published API specification (`dist/spec/openapi.json`), so the extension
 * decides.
 */
const SPEC_DIRS = new Set(['spec', 'specs', '__spec__', '__specs__']);

/** `client.test.js`, `client.spec.ts`, `client.TEST.js.map`. */
const TEST_BASENAME = /\.(?:test|spec)\./i;

/**
 * Classify one tarball entry path (POSIX, relative to the package root, as
 * `npm pack --json` reports it).
 *
 * Returns `null` for anything a package may legitimately publish, or
 * `{ path, rule }` naming the rule that flagged it. The rules, in order:
 *
 *   1. `test-dir`  — a directory segment named `test`, `tests`, `__test__` or
 *      `__tests__` (case-insensitive), whatever the file's extension. Nothing
 *      a package publishes belongs under a directory with one of those names.
 *   2. `spec-dir`  — a directory segment named `spec`, `specs`, `__spec__` or
 *      `__specs__` (case-insensitive), for code files only.
 *   3. `test-file` — a basename containing `.test.` or `.spec.`
 *      (case-insensitive), for code files only. This is the shape `tsc` emits
 *      from `src/*.test.ts`: `.js`, `.d.ts`, `.js.map`.
 *
 * Deliberately NOT covered, and not claimed anywhere: separator variants such
 * as `client-test.js` and `client_test.js`. No toolchain in this repo emits
 * them from a `*.test.ts` source, and they are as likely to be a legitimate
 * module name as a leak. Nor are non-code files outside a `test/` directory —
 * see CODE_FILE above.
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
  'test-dir': 'lives under a test/ directory',
  'spec-dir': 'code file under a spec/ directory',
  'test-file': '.test. / .spec. module',
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
