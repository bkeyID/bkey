/**
 * Unit tests for the published-tarball matcher.
 *
 * Run by `node --test scripts/` in CI. Node's built-in test runner, not
 * vitest: this is workspace tooling, it must be runnable before (and
 * independently of) `pnpm install` and the build, and a gate that needs its
 * own dependency graph installed is a gate that can be skipped.
 *
 * The first block is the exact table from the review of the predecessor gate.
 * Its regex was `/(^|\/)(__tests__\/|[^/]*\.(test|spec)\.)/`, which flagged
 * one of the seven paths correctly and got a legitimate fixture wrong.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyEntry,
  findTestArtifacts,
  hasJsModule,
  isTestSource,
  tarballFilePaths,
  declaredEntryPoints,
  typecheckProjects,
} from './pack-contents.mjs';

const flagged = (path) => classifyEntry(path)?.rule ?? null;

describe('classifyEntry — the paths the predecessor gate got wrong', () => {
  // [path, expected rule or null, what the predecessor did]
  const CASES = [
    ['dist/client.test.js', 'test-file', 'flagged — the only one it got right'],
    ['dist/tests/helpers.js', 'test-dir', 'passed'],
    ['dist/test/foo.js', 'test-dir', 'passed'],
    ['dist/client-test.js', null, 'passed, and still passes: see the doc comment'],
    ['dist/client_test.js', null, 'passed, and still passes: see the doc comment'],
    ['dist/client.TEST.js', 'test-file', 'passed — its regex was case-sensitive'],
    ['dist/openapi.spec.json', null, 'flagged — false positive on a real fixture'],
  ];

  for (const [path, expected, predecessor] of CASES) {
    test(`${path} → ${expected ?? 'clean'} (predecessor: ${predecessor})`, () => {
      assert.equal(flagged(path), expected);
    });
  }
});

describe('classifyEntry — artifacts tsc emits from a *.test.ts source', () => {
  for (const path of [
    'dist/client.test.js',
    'dist/client.test.d.ts',
    'dist/client.test.js.map',
    'dist/client.test.d.ts.map',
    'dist/client.test.mjs',
    'dist/client.test.cjs',
    'dist/nested/deep/client.spec.js',
    'dist/client.spec.d.ts',
  ]) {
    test(path, () => assert.equal(flagged(path), 'test-file'));
  }
});

describe('classifyEntry — artifacts tsc emits from a *.test-d.ts source', () => {
  // `*.test-d.ts` is vitest's own default type-test naming convention
  // (`typecheck.include` defaults to `**/*.test-d.?(c|m)[jt]s?(x)`), and an
  // `"exclude": ["src/**/*.test.ts"]` does not match it — so tsc emitted all
  // of these into dist/ and `files: ["dist"]` published them, while the
  // matcher's `/\.(?:test|spec)\./` saw a hyphen where it wanted a dot.
  for (const path of [
    'dist/client.test-d.js',
    'dist/client.test-d.d.ts',
    'dist/client.test-d.js.map',
    'dist/client.test-d.d.ts.map',
    'dist/client.test-d.ts',
    'dist/client.test-d.mjs',
    'dist/client.test-d.cjs',
    'dist/client.test-d.mts',
    'dist/client.test-d.cts',
    'dist/client.test-d.tsx',
    'dist/client.TEST-D.js',
    'dist/nested/deep/client.spec-d.js',
    'dist/client.spec-d.d.ts',
  ]) {
    test(path, () => assert.equal(flagged(path), 'test-file'));
  }
});

describe('classifyEntry — test directories, at any depth and any case', () => {
  for (const path of [
    'dist/test/foo.js',
    'dist/tests/helpers.js',
    'dist/__tests__/setup.js',
    'dist/__test__/setup.js',
    'dist/__mocks__/client.js',
    'dist/__MOCKS__/client.js',
    'dist/a/b/__mocks__/fs.js',
    'dist/__mocks__/fixture.json',
    'dist/Tests/Helpers.js',
    'dist/TEST/foo.js',
    'test/foo.js',
    'dist/a/b/tests/c/d.js',
    // Rule 1 does not require a code extension: nothing a package publishes
    // belongs under a directory literally named `test`.
    'dist/tests/fixtures/payload.json',
    'dist/__tests__/README.md',
  ]) {
    test(path, () => assert.equal(flagged(path), 'test-dir'));
  }
});

describe('classifyEntry — spec directories need a code extension', () => {
  test('dist/spec/helpers.js is a test artifact', () => {
    assert.equal(flagged('dist/spec/helpers.js'), 'spec-dir');
  });
  test('dist/specs/helpers.ts is a test artifact', () => {
    assert.equal(flagged('dist/specs/helpers.ts'), 'spec-dir');
  });
  test('dist/spec/openapi.json is a published specification, not a test', () => {
    assert.equal(flagged('dist/spec/openapi.json'), null);
  });
});

describe('classifyEntry — files a package may legitimately publish', () => {
  for (const path of [
    'package.json',
    'README.md',
    'LICENSE',
    'dist/index.js',
    'dist/index.d.ts',
    'dist/index.js.map',
    'dist/client.js',
    'dist/express.js',
    'dist/fastify.d.ts',
    'dist/openapi.spec.json',
    'dist/openapi.test.json',
    'dist/latest/index.js',
    'dist/protest/index.js',
    'dist/contest.js',
    'dist/testing.js',
    'dist/specialize.js',
    'dist/client-test.js',
    'dist/client_test.js',
    // `-d` only counts when the extension dot follows it.
    'dist/client.test-data.js',
    'dist/client.test-doubles.js',
    'dist/client.spec-driven.js',
    'dist/client.test-d.json',
    'dist/mocks/client.js',
  ]) {
    test(path, () => assert.equal(flagged(path), null));
  }
});

describe('classifyEntry — fails closed on unusable input', () => {
  for (const bad of [undefined, null, '', 42, {}]) {
    test(`throws on ${JSON.stringify(bad) ?? String(bad)}`, () => {
      assert.throws(() => classifyEntry(bad), TypeError);
    });
  }
});

describe('findTestArtifacts', () => {
  test('returns every hit, in input order, with its rule', () => {
    const hits = findTestArtifacts([
      'package.json',
      'dist/index.js',
      'dist/client.test.js',
      'dist/client.test-d.d.ts',
      'dist/openapi.spec.json',
      'dist/__mocks__/fs.js',
      'dist/tests/helpers.js',
    ]);
    assert.deepEqual(hits, [
      { path: 'dist/client.test.js', rule: 'test-file' },
      { path: 'dist/client.test-d.d.ts', rule: 'test-file' },
      { path: 'dist/__mocks__/fs.js', rule: 'test-dir' },
      { path: 'dist/tests/helpers.js', rule: 'test-dir' },
    ]);
  });

  test('a clean file list yields no hits', () => {
    assert.deepEqual(findTestArtifacts(['package.json', 'dist/index.js']), []);
  });
});

describe('hasJsModule', () => {
  test('true for .js, .mjs and .cjs', () => {
    assert.equal(hasJsModule(['package.json', 'dist/index.js']), true);
    assert.equal(hasJsModule(['dist/index.mjs']), true);
    assert.equal(hasJsModule(['dist/index.cjs']), true);
  });

  test('false for the tarball the predecessor gate passed', () => {
    // `packages/sdk/dist` moved aside: the predecessor printed
    // "ok @bkey/sdk — 1 files, no test artifacts" and exited 0.
    assert.equal(hasJsModule(['package.json']), false);
  });

  test('false for declarations and maps alone', () => {
    assert.equal(hasJsModule(['dist/index.d.ts', 'dist/index.js.map']), false);
  });
});

describe('tarballFilePaths — fails closed on every shape it cannot read', () => {
  const ok = JSON.stringify([
    { entryCount: 2, files: [{ path: 'package.json' }, { path: 'dist/index.js' }] },
  ]);

  test('reads the array form npm actually emits', () => {
    assert.deepEqual(tarballFilePaths(ok, '@bkey/sdk'), ['package.json', 'dist/index.js']);
  });

  test('reads a bare object too', () => {
    const bare = JSON.stringify({ files: [{ path: 'package.json' }] });
    assert.deepEqual(tarballFilePaths(bare, '@bkey/sdk'), ['package.json']);
  });

  test('throws on unparseable output', () => {
    assert.throws(() => tarballFilePaths('not json', '@bkey/sdk'), /unparseable JSON/);
  });

  test('throws when there is no tarball entry', () => {
    assert.throws(() => tarballFilePaths('[]', '@bkey/sdk'), /no tarball/);
    assert.throws(() => tarballFilePaths('null', '@bkey/sdk'), /no tarball/);
  });

  test('throws when files is missing or not an array', () => {
    assert.throws(() => tarballFilePaths('[{}]', '@bkey/sdk'), /no file list/);
    assert.throws(() => tarballFilePaths('[{"files":{}}]', '@bkey/sdk'), /no file list/);
  });

  test('throws when an entry has no path — the predecessor scanned "undefined"', () => {
    const noPath = JSON.stringify([{ files: [{ path: 'dist/index.js' }, { size: 10 }] }]);
    assert.throws(() => tarballFilePaths(noPath, '@bkey/sdk'), /without a usable "path"/);
  });

  test('throws when entryCount disagrees with the list', () => {
    const short = JSON.stringify([{ entryCount: 16, files: [{ path: 'package.json' }] }]);
    assert.throws(() => tarballFilePaths(short, '@bkey/sdk'), /entryCount 16/);
  });

  test('throws on an empty file list', () => {
    assert.throws(() => tarballFilePaths('[{"files":[]}]', '@bkey/sdk'), /empty tarball/);
  });
});

describe('declaredEntryPoints', () => {
  test('collects main, types, exports and bin, normalized and deduped', () => {
    assert.deepEqual(
      declaredEntryPoints({
        main: 'dist/index.js',
        types: 'dist/index.d.ts',
        exports: {
          '.': { import: './dist/index.js', types: './dist/index.d.ts' },
          './express': { import: './dist/express.js', types: './dist/express.d.ts' },
        },
        bin: { bkey: './dist/cli.js' },
      }),
      [
        'dist/cli.js',
        'dist/express.d.ts',
        'dist/express.js',
        'dist/index.d.ts',
        'dist/index.js',
      ],
    );
  });

  test('handles a string bin and a string exports', () => {
    assert.deepEqual(declaredEntryPoints({ bin: './dist/cli.js', exports: './dist/index.js' }), [
      'dist/cli.js',
      'dist/index.js',
    ]);
  });

  test('handles fallback arrays inside exports', () => {
    assert.deepEqual(declaredEntryPoints({ exports: { '.': ['./dist/a.js', './dist/b.js'] } }), [
      'dist/a.js',
      'dist/b.js',
    ]);
  });

  test('skips subpath patterns — there is no single file to look for', () => {
    assert.deepEqual(declaredEntryPoints({ exports: { './*': './dist/*.js' } }), []);
  });

  test('skips targets outside the package', () => {
    assert.deepEqual(declaredEntryPoints({ main: '../elsewhere/index.js' }), []);
    assert.deepEqual(declaredEntryPoints({ main: '/abs/index.js' }), []);
  });

  test('returns nothing for a manifest that declares nothing', () => {
    assert.deepEqual(declaredEntryPoints({ name: '@bkey/sdk', files: ['dist'] }), []);
  });
});

describe('isTestSource — which sources check C demands typechecking for', () => {
  for (const name of [
    'client.test.ts',
    'client.test.tsx',
    'client.test.mts',
    'client.test.cts',
    'client.spec.ts',
    'client.TEST.TS',
    // The shape that slipped through: check C's old `/\.test\.[cm]?tsx?$/`
    // never saw it, so a package holding only type tests reported full
    // coverage. `vitest run` does not typecheck these — `typecheck.include`
    // applies only under `--typecheck`.
    'client.test-d.ts',
    'client.test-d.tsx',
    'client.test-d.mts',
    'client.test-d.cts',
    'client.spec-d.ts',
  ]) {
    test(`${name} is a test source`, () => assert.equal(isTestSource(name), true));
  }

  for (const name of [
    'client.ts',
    'index.ts',
    'testing.ts',
    'contest.ts',
    'client.test-data.ts',
    'client-test.ts',
    'client_test.ts',
    // Emitted artifacts are check A's job, not check C's.
    'client.test.js',
    'client.test-d.js',
    'client.test.d.ts',
  ]) {
    test(`${name} is not a test source`, () => assert.equal(isTestSource(name), false));
  }

  for (const bad of [undefined, null, 42, {}]) {
    test(`returns false for ${JSON.stringify(bad) ?? String(bad)}`, () => {
      assert.equal(isTestSource(bad), false);
    });
  }
});

describe('typecheckProjects — reads the -p argument, not any substring', () => {
  test('the plain form every package uses', () => {
    assert.deepEqual(typecheckProjects('tsc -p tsconfig.test.json'), ['tsconfig.test.json']);
  });

  test('--project, long and inline forms', () => {
    assert.deepEqual(typecheckProjects('tsc --project tsconfig.test.json'), [
      'tsconfig.test.json',
    ]);
    assert.deepEqual(typecheckProjects('tsc --project=tsconfig.test.json'), [
      'tsconfig.test.json',
    ]);
    assert.deepEqual(typecheckProjects('tsc -p=tsconfig.test.json'), ['tsconfig.test.json']);
  });

  test('strips ./ and surrounding quotes so paths compare equal', () => {
    assert.deepEqual(typecheckProjects('tsc -p ./tsconfig.test.json'), ['tsconfig.test.json']);
    assert.deepEqual(typecheckProjects('tsc -p "tsconfig.test.json"'), ['tsconfig.test.json']);
  });

  test('collects every project in a chained script', () => {
    assert.deepEqual(typecheckProjects('tsc -p tsconfig.json && tsc -p tsconfig.test.json'), [
      'tsconfig.json',
      'tsconfig.test.json',
    ]);
  });

  test('a shell comment mentioning the config does not count as running it', () => {
    // The bypass this replaced a substring test to close: npm runs scripts
    // through `sh`, which drops the comment before `tsc` ever sees it, so the
    // old `script.includes('tsconfig.test.json')` passed a package that
    // typechecked only its build program.
    assert.deepEqual(typecheckProjects('tsc -p tsconfig.json # tsconfig.test.json'), [
      'tsconfig.json',
    ]);
    assert.equal(
      typecheckProjects('tsc -p tsconfig.json # tsconfig.test.json').includes(
        'tsconfig.test.json',
      ),
      false,
    );
  });

  test('a bare mention with no -p at all counts as nothing', () => {
    assert.deepEqual(typecheckProjects('echo tsconfig.test.json'), []);
    assert.deepEqual(typecheckProjects('tsc'), []);
    assert.deepEqual(typecheckProjects('tsc --noEmit'), []);
  });

  test('a dangling -p yields no project rather than a bogus one', () => {
    assert.deepEqual(typecheckProjects('tsc -p'), []);
    assert.deepEqual(typecheckProjects('tsc -p --noEmit'), []);
    assert.deepEqual(typecheckProjects('tsc -p # tsconfig.test.json'), []);
  });

  test('returns nothing for a missing script instead of throwing', () => {
    assert.deepEqual(typecheckProjects(undefined), []);
    assert.deepEqual(typecheckProjects(null), []);
    assert.deepEqual(typecheckProjects(42), []);
  });
});
