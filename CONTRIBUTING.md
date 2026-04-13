# Contributing to BKey

Thank you for your interest in contributing to BKey.

## Development Setup

### TypeScript packages

```bash
cd typescript
pnpm install
pnpm build
```

### Python package

```bash
cd python
pip install -e ".[all]"
pytest
```

## Pull Requests

1. Fork the repo and create a branch from `main`
2. Make your changes and add tests if applicable
3. Run `pnpm build` (TypeScript) or `pytest` (Python) to verify
4. Submit a PR with a clear description

## Release Process

Packages are published via CI when a release tag is pushed:
- `@bkey/sdk@x.y.z` — npm
- `@bkey/cli@x.y.z` — npm
- `bkey==x.y.z` — PyPI

## Code of Conduct

Be respectful and constructive. We follow the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).
