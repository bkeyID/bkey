# Releasing

> **Current mode: manual.** Auto-publish on release tag is disabled in
> `.github/workflows/publish-npm.yml` and `publish-pypi.yml` — we're cutting
> releases from the laptop for now while the NPM token scope is still being
> sorted out. See [Re-enabling auto-publish](#re-enabling-auto-publish) when
> ready.

## Manual release flow (current)

### 1. Bump the version

Only bump the package you're releasing:

```bash
# For @bkey/sdk
# Edit: typescript/packages/sdk/package.json → "version": "0.2.0"

# For @bkey/cli
# Edit: typescript/packages/cli/package.json → "version": "0.2.0"

# For @bkey/node
# Edit: typescript/packages/node/package.json → "version": "0.2.0"

# For bkey-sdk (Python)
# Edit: python/pyproject.toml → version = "0.2.0"
# Edit: python/bkey/__init__.py → __version__ = "0.2.0"
```

### 2. Commit and push (via a PR)

```bash
git checkout -b chore/bump-sdk-0.2.0
git add -A
git commit -m "chore: bump @bkey/sdk to 0.2.0"
git push -u origin chore/bump-sdk-0.2.0
gh pr create --fill
# ... review + merge
```

### 3. Publish from the laptop

Always use `pnpm publish` for TypeScript packages — pnpm resolves
`workspace:*` dependencies to actual version numbers.

```bash
cd typescript
pnpm install
pnpm build

# pick the package
pnpm --filter @bkey/sdk publish --access public --no-git-checks
# or
pnpm --filter @bkey/cli publish --access public --no-git-checks
# or
pnpm --filter @bkey/node publish --access public --no-git-checks
```

For Python:

```bash
cd python
uv build
uv publish --token $PYPI_TOKEN
```

For Rust (no CI yet):

```bash
cd rust
# bump version in Cargo.toml
cargo publish
```

### 4. Cut the GitHub release (after publish succeeds)

```bash
gh release create sdk-v0.2.0 --title "@bkey/sdk v0.2.0" --generate-notes
# (same pattern for cli-v*, node-v*, python-v*)
```

Tag prefixes are documented for when auto-publish gets re-enabled; they
have no runtime effect while we're manual.

### 5. Verify

```bash
npm view @bkey/sdk version
npm view @bkey/cli version
npm view @bkey/node version
pip index versions bkey-sdk
```

## Tag conventions

Per-package tag prefixes used for releases and (when re-enabled) CI
dispatch:

| Tag pattern | Package | Registry |
|-------------|---------|----------|
| `sdk-v0.2.0` | `@bkey/sdk` | npm |
| `cli-v0.2.0` | `@bkey/cli` | npm |
| `node-v0.2.0` | `@bkey/node` | npm |
| `python-v0.2.0` | `bkey-sdk` | PyPI |

## Workflow_dispatch fallback

Both publish workflows still exist and can be triggered manually via the
GitHub Actions UI:

1. Go to **Actions → Publish npm packages → Run workflow**
2. Pick the package from the dropdown (`sdk`, `cli`, `node`)
3. Run

Requires `NPM_TOKEN` (granular, `@bkey/*` scope incl. `@bkey/node`) to be
current. If you hit a 404 on publish, the token isn't scoped to that
package — edit the token on npmjs.com and re-run.

## Re-enabling auto-publish

When we want auto-publish on release tag back:

In `.github/workflows/publish-npm.yml`:

```diff
-on:
-  workflow_dispatch:
-    inputs:
-      package:
-        description: Which package to publish
-        required: true
-        type: choice
-        options: [sdk, cli, node]
+on:
+  release:
+    types: [published]
```

And restore the per-job tag guards:

```diff
-    if: github.event.inputs.package == 'sdk'
+    if: startsWith(github.event.release.tag_name, 'sdk-v')
```

(Same pattern for `cli-v` and `node-v`.) Same shape in
`publish-pypi.yml` with `python-v` guard.

## Required secrets

Set in repo Settings → Secrets → Actions:

| Secret | Purpose |
|--------|---------|
| `NPM_TOKEN` | npm granular access token with publish to `@bkey/*` (verify it covers **all three** of `@bkey/sdk`, `@bkey/cli`, `@bkey/node` — missing `@bkey/node` is what broke the last auto-publish attempt) |
| `PYPI_TOKEN` | PyPI API token scoped to `bkey-sdk` |
