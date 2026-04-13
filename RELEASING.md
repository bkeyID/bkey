# Releasing

## How releases work

Releases are triggered by **GitHub Releases**. When you create a release with a tag like `v0.2.0`, CI automatically publishes:

- `@bkey/sdk` + `@bkey/cli` → npm
- `bkey-sdk` → PyPI

## Step-by-step

### 1. Bump versions

Update version numbers in all package files:

```bash
# TypeScript SDK
# typescript/packages/sdk/package.json → "version": "0.2.0"

# TypeScript CLI
# typescript/packages/cli/package.json → "version": "0.2.0"

# Python SDK
# python/pyproject.toml → version = "0.2.0"
# python/bkey/__init__.py → __version__ = "0.2.0"

# Rust (if publishing)
# rust/Cargo.toml → version = "0.2.0"
```

### 2. Commit and push

```bash
git add -A
git commit -m "chore: bump version to 0.2.0"
git push
```

### 3. Create GitHub release

```bash
gh release create v0.2.0 --title "v0.2.0" --generate-notes
```

Or with custom notes:

```bash
gh release create v0.2.0 --title "v0.2.0" --notes "## Changes
- Feature X
- Fix Y
"
```

CI will automatically publish to npm and PyPI.

### 4. Verify

```bash
npm info @bkey/sdk version    # should show 0.2.0
pip index versions bkey-sdk   # should show 0.2.0
```

## Required secrets

These must be set in the repo's Settings → Secrets → Actions:

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
