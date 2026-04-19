# Releasing

## Per-package releases

Each package is released independently using **per-package tags**. CI detects the tag prefix and publishes only the matching package.

| Tag pattern | Publishes | Registry |
|-------------|-----------|----------|
| `sdk-v0.2.0` | `@bkey/sdk` | npm |
| `cli-v0.2.0` | `@bkey/cli` | npm |
| `node-v0.2.0` | `@bkey/node` | npm |
| `python-v0.2.0` | `bkey-sdk` | PyPI |

## Step-by-step

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
```

> The CLI's `bkey version` output and `bkey.__version__` are derived from
> `package.json` / `pyproject.toml` at build/import time — you do not need to
> edit any source file separately.

### 2. Commit and push

```bash
git add -A
git commit -m "chore: bump @bkey/sdk to 0.2.0"
git push
```

### 3. Create a GitHub release

```bash
# SDK release
gh release create sdk-v0.2.0 --title "@bkey/sdk v0.2.0" --generate-notes

# CLI release
gh release create cli-v0.2.0 --title "@bkey/cli v0.2.0" --generate-notes

# Python release
gh release create python-v0.2.0 --title "bkey-sdk v0.2.0" --generate-notes
```

CI automatically publishes to the correct registry.

### 4. Verify

```bash
# npm
npm view @bkey/sdk version
npm view @bkey/cli version

# PyPI
pip index versions bkey-sdk
```

## Multiple packages in one session

If both SDK and CLI change together:

```bash
# Bump both versions, commit, push
git commit -m "chore: bump sdk to 0.2.0, cli to 0.2.0"
git push

# Create two separate releases
gh release create sdk-v0.2.0 --title "@bkey/sdk v0.2.0" --notes "..."
gh release create cli-v0.2.0 --title "@bkey/cli v0.2.0" --notes "..."
```

Each triggers its own CI job independently.

## Manual publishing (if needed)

Always use `pnpm publish` (not `npm publish`) for TypeScript packages — pnpm resolves `workspace:*` dependencies to actual version numbers.

```bash
cd typescript
pnpm --filter @bkey/sdk publish --access public --no-git-checks
pnpm --filter @bkey/cli publish --access public --no-git-checks
```

For Python:
```bash
cd python
uv build && uv publish --token YOUR_TOKEN
```

## Required secrets

Set in repo Settings → Secrets → Actions:

| Secret | Purpose |
|--------|---------|
| `NPM_TOKEN` | npm granular access token with publish to `@bkey/*` |
| `PYPI_TOKEN` | PyPI API token scoped to `bkey-sdk` |

## Rust releases

Rust crate is published manually (no CI yet):

```bash
cd rust
# bump version in Cargo.toml
cargo publish
```
