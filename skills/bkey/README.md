# BKey Agent Skill

Agent skill for BKey — biometric approval, vault access, and agentic checkout.

Follows the [agentskills.io](https://agentskills.io) specification. Works with Claude Code, OpenClaw, Codex, Copilot, Cursor, and 26+ other agent platforms.

## Capabilities

| Capability | Commands | Description |
|-----------|----------|-------------|
| **Approval** | `bkey approve` | CIBA biometric approval for any action |
| **Vault proxy** | `bkey proxy`, `bkey wrap` | Authenticated API calls with E2EE secrets |
| **Checkout** | `bkey checkout request` | Agent-initiated purchases with biometric approval |
| **Auth** | `bkey auth login`, `bkey auth status` | CLI authentication |

See [`SKILL.md`](SKILL.md) for the full skill definition with usage examples and workflows.

## Installation

### 1. Install the CLI

```bash
npm install -g @bkey/cli
```

### 2. Add the skill to your agent platform

**Claude Code:**
```bash
cp -r skills/bkey ~/.claude/skills/bkey
```

**OpenClaw:** Add via `skills.load.extraDirs` or copy to `~/.openclaw/skills/`.

**Any agentskills.io platform:** Copy `skills/bkey/SKILL.md` to your platform's skills directory.

### 3. Authenticate

```bash
# Interactive login (human)
bkey auth login

# Or agent/CI mode
export BKEY_CLIENT_ID=bkey_client_...
export BKEY_CLIENT_SECRET=bkey_secret_...
```

## Related

- [`@bkey/sdk`](https://www.npmjs.com/package/@bkey/sdk) — TypeScript SDK
- [`@bkey/cli`](https://www.npmjs.com/package/@bkey/cli) — CLI tool
- [`bkey-sdk`](https://pypi.org/project/bkey-sdk/) — Python SDK
- [Developer Docs](https://bkey.id/docs) — Full documentation
