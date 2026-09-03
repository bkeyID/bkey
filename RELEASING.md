# Releasing

## Per-package releases

Each package is released independently using **per-package tags**. CI detects the tag prefix and publishes only the matching package.

| Tag pattern | Publishes | Registry |
|-------------|-----------|----------|
| `sdk-v0.2.0` | `@bkey/sdk` | npm |
| `cli-v0.2.0` | `@bkey/cli` | npm |
| `node-v0.2.0` | `@bkey/node` | npm |
| `login-v0.1.0` | `@bkey/login` | npm |
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

# For @bkey/login
# Edit: typescript/packages/login/package.json → "version": "0.1.0"

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

# Login release
gh release create login-v0.1.0 --title "@bkey/login v0.1.0" --generate-notes

# Python release
gh release create python-v0.2.0 --title "bkey-sdk v0.2.0" --generate-notes
```

CI automatically publishes to the correct registry.

### 4. Verify

```bash
# npm
npm view @bkey/sdk version
npm view @bkey/cli version
npm view @bkey/node version
npm view @bkey/login version

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

## Provenance

Every npm publish runs with `--provenance` from GitHub Actions, so npm records a
signed attestation linking the tarball to the workflow run and commit that built
it. The package page shows a **"Built and signed on GitHub Actions"** badge, and
`npm audit signatures` verifies it.

This requires two things that are already wired up in `publish-npm.yml` and must
not be removed:

- `permissions: id-token: write` on each publish job (the OIDC token npm
  exchanges for the attestation)
- an `NPM_TOKEN` that is a **granular** access token — classic automation tokens
  cannot attach provenance

Provenance also requires the repo to be public and the package to be public,
both of which hold here.

## First publish of a new package

npm has no record of a scoped package until its first successful publish, so the
first release of a new `@bkey/*` package needs the publishing token to have
permission to **create** packages in the `@bkey` scope — not just write to
existing ones. If the first release fails with `404 Not Found - PUT`, that is
almost always the token's scope, not a missing `--access public`.

After the first publish, confirm the package is public and provenance attached:

```bash
npm view @bkey/<pkg> --json | grep -E '"name"|"version"'
npm audit signatures
```

## Required secrets

Set in repo Settings → Secrets → Actions:

| Secret | Purpose |
|--------|---------|
| `NPM_TOKEN` | npm **granular** access token with read/write on the `@bkey` scope, including permission to create new packages. Classic tokens cannot attach provenance. |
| `PYPI_TOKEN` | PyPI API token scoped to `bkey-sdk` |

## Rust releases

Rust crate is published manually (no CI yet):

```bash
cd rust
# bump version in Cargo.toml
cargo publish
```
