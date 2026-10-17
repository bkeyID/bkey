import { build } from 'esbuild';
import { rm, readFile, writeFile, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
await rm('dist', { recursive: true, force: true });
const common = { bundle: true, platform: 'browser', target: ['es2022'], sourcemap: true, minify: true, legalComments: 'linked', banner: { js: '/*! Bundled QR code dependencies: see THIRD-PARTY-LICENSES.txt. */' } };
await build({ ...common, entryPoints: ['src/index.ts'], outdir: 'dist', format: 'esm' });
await build({ ...common, entryPoints: ['src/browser.ts'], outfile: 'dist/api.js', format: 'iife', globalName: 'bkey' });
const require = createRequire(import.meta.url);
const qrManifest = require.resolve('qrcode/package.json');
const qrRequire = createRequire(qrManifest);
const licenses = [
  ['qrcode', join(dirname(qrManifest), 'license')],
  ['dijkstrajs', join(dirname(qrRequire.resolve('dijkstrajs/package.json')), 'LICENSE.md')],
];
await writeFile('dist/THIRD-PARTY-LICENSES.txt', (await Promise.all(licenses.map(async ([name, path]) => `${name}\n\n${await readFile(path, 'utf8')}`))).join('\n\n'));
await copyFile('../../../LICENSE', 'dist/LICENSE');
