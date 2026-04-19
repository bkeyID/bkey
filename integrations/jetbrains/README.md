# BKey Approval — JetBrains Plugin

Biometric approval for git commits in any JetBrains IDE — IntelliJ IDEA, WebStorm,
PyCharm, GoLand, and the JetBrains AI IDEs (Junie, Codex, AI Assistant).

Every commit triggers a push notification to your phone. Approve with Face ID to
continue, deny to block the commit. This is the same flow whether *you* click
Commit or an AI agent does it.

## Why

AI coding agents (Junie, Codex, Copilot) can now make changes, run tests, and
commit on their own. That speed is great — until an agent commits something you
wouldn't have. This plugin puts a human-in-the-loop gate on the single
highest-leverage action: the commit itself.

Because the plugin hooks the IDE's VCS pipeline (`CheckinHandler`), it fires for
every commit regardless of origin. Human, AI agent, keyboard shortcut — all
funnel through the same BKey approval.

## How it works

```
AI agent / you click "Commit"
        │
        ▼
  IntelliJ CheckinHandler  ──► bkey approve "<commit msg> [files…]"
                                       │
                                       ▼
                                Phone push notification
                                       │
                                       ▼
                             Face ID → approved / denied
                                       │
        ┌──────────────────────────────┘
        ▼
  Commit proceeds (or is cancelled)
```

The plugin is a thin wrapper around the `bkey` CLI. All OAuth/CIBA state lives
in the CLI's existing device-auth session — no separate login inside the IDE.

## Prerequisites

1. BKey CLI **≥ 0.3.0**, authenticated as both human and agent:

   ```bash
   npm install -g @bkey/cli
   bkey auth login                  # 1. human session — provides the user DID
   bkey auth setup-agent --save     # 2. agent OAuth client — signs CIBA requests
   ```

   Both coexist (`~/.bkey/config.json` + `~/.bkey/agent.json`). The plugin sets
   `BKEY_MODE=agent` when shelling out, so it always runs as the agent without
   clobbering your terminal's human session.

   Verify: `bkey auth status` (human) and `bkey auth status --agent` (agent)
   both show credentials.

2. A JetBrains IDE on build **243** (2024.3) or newer.

## Install (Marketplace)

> Not yet published — install from source for now (see below). Once published:
>
> `Settings → Plugins → Marketplace → search "BKey Approval" → Install`.

## Install from source

```bash
git clone https://github.com/bkeyID/bkey.git
cd bkey/integrations/jetbrains

# Build the .zip distribution
./gradlew buildPlugin
# Output: build/distributions/bkey-jetbrains-<version>.zip
```

Then in your IDE: `Settings → Plugins → ⚙ → Install Plugin from Disk…` and
select the zip.

Or run a sandbox IDE with the plugin pre-loaded:

```bash
./gradlew runIde
```

> First build requires a JDK 17+ and downloads the IntelliJ Platform SDK
> (~1 GB). If you don't have `gradlew`, run `gradle wrapper` once to generate it.

## Configure

`Settings → Tools → BKey Approval`:

| Setting | Default | Purpose |
| --- | --- | --- |
| Require BKey approval for commits | `true` | Master switch |
| bkey CLI path | `bkey` | Full path if not on PATH (e.g. `/usr/local/bin/bkey`) |
| Agent profile | *(empty)* | Named agent profile to use (CLI ≥ 0.3.0). Empty = CLI's default agent. |
| Approval scope | `approve:action` | CIBA scope passed to `--scope`. Must be one of the agent's allowed scopes — `bkey auth setup-agent --save` grants `approve:action` by default. |
| Timeout (seconds) | `120` | Max wait for phone approval |
| User DID | *(empty)* | Override `--user-did`; empty = CLI falls back to the logged-in session's DID |
| Include diff summary | `true` | Append file list to the binding message |
| Auto-install commit-msg hook | `false` | Writes `.git/hooks/commit-msg` to every opened git project (see below). |

### Catching agent commits from the terminal

The plugin's `CheckinHandler` only fires for commits that go through IntelliJ's VCS API — the Commit dialog, `⌘K`, the sidebar Commit button. AI coding agents (Junie, Codex, Claude Code) often commit by **shelling out to `git commit` in a terminal they spawn themselves**, which bypasses that pipeline. Those commits appear on your branch with no BKey approval.

The fix is a `commit-msg` git hook — git invokes it for every commit regardless of origin. Enable it under **Settings → Tools → BKey Approval**:

- **Install in current project** button — drops `.git/hooks/commit-msg` into the repo you have open, gating every subsequent commit on `bkey approve`.
- **Auto-install commit-msg hook** checkbox — when on, the plugin does the install automatically on every project open. Default off (plugin modifies files in your repo, so opt in explicitly).
- **Remove from current project** button — cleans up. The plugin refuses to touch non-BKey hooks; if you already had a `commit-msg` hook, we leave it alone and log a skip.

The installed hook is a 30-line bash script that shells out to `bkey approve --json` with the commit message as the binding message. It's self-contained — `git commit` from the terminal, from Codex's subshell, from the IDE all hit the same gate.

### Multiple agents

CLI 0.3.0 lets one machine hold multiple named agent profiles
(`bkey profiles list`). If you've created one specifically for your IDE
(e.g. `bkey auth setup-agent --save --name "IDE Agent"` saves as `ide-agent`),
put that identifier in the **Agent profile** field. The plugin then always
runs as that agent regardless of what `bkey profiles use --agent` is set to
on your shell, so the IDE's audit trail stays clean and isolated.

## Use

1. Make changes (or let your AI agent make them).
2. Trigger a commit — `⌘K` / `Ctrl+K` / agent action, doesn't matter.
3. The commit dialog shows a **"Skip BKey approval for this commit"** checkbox.
   Leave it unchecked for the normal flow.
4. Click Commit. A modal appears: *"Waiting for BKey approval — check your
   phone."*
5. Approve with Face ID on your phone.
6. Commit proceeds, or is cancelled with the denial reason.

### Bypass for this commit

Tick the **Skip BKey approval** checkbox in the commit dialog. State is
per-dialog — the next commit will require approval again.

### Disable globally

`Settings → Tools → BKey Approval → uncheck "Require BKey approval for commits"`.

## Troubleshooting

**"Could not run 'bkey'"**
The plugin can't find the CLI on your `PATH`. Set the full path in settings,
e.g. `/opt/homebrew/bin/bkey` or `$(which bkey)`.

**Approval times out**
Check OneSignal push delivery on your phone. The CLI also supports a polling
fallback — run `bkey approve "test" --json` in a terminal to confirm end-to-end
connectivity before blaming the plugin.

**I want to approve only AI commits, not my own**
JetBrains doesn't currently expose a reliable "this commit came from the AI
agent" signal. Use the **Skip BKey approval** checkbox as a per-commit human
override. A future release may add heuristics (recent AI Chat activity, commit
trailers) to auto-detect AI authorship.

## Development

```
integrations/jetbrains/
├── build.gradle.kts         # IntelliJ Platform Gradle plugin 2.x
├── gradle.properties        # Target platform version, plugin version
├── settings.gradle.kts
└── src/main/
    ├── kotlin/id/bkey/jetbrains/
    │   ├── BKeyCheckinHandler.kt         # beforeCheckin() gate
    │   ├── BKeyCheckinHandlerFactory.kt  # registers the handler
    │   ├── BKeyCliRunner.kt              # shells out to bkey CLI
    │   ├── BKeyNotifications.kt          # IDE balloon notifications
    │   └── settings/
    │       ├── BKeySettings.kt           # persistent state
    │       └── BKeyConfigurable.kt       # Settings → Tools → BKey
    └── resources/
        ├── META-INF/plugin.xml           # plugin descriptor
        └── messages/BKeyBundle.properties
```

Useful tasks:

```bash
./gradlew runIde          # sandbox IDE with the plugin loaded
./gradlew buildPlugin     # produces installable zip
./gradlew verifyPlugin    # checks against IntelliJ plugin verifier
./gradlew publishPlugin   # publishes to Marketplace (needs JETBRAINS_MARKETPLACE_TOKEN)
```

## License

Apache-2.0 — same as the rest of the BKey repo.
