package id.bkey.jetbrains

import com.intellij.openapi.diagnostic.Logger
import id.bkey.jetbrains.settings.BKeySettings
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.PosixFilePermission
import java.nio.file.attribute.PosixFilePermissions

/**
 * Install / remove / inspect a `commit-msg` git hook that gates every commit
 * in the target repo on BKey approval. Keeps coverage complete regardless of
 * how the commit was initiated — IntelliJ VCS UI, terminal, AI-agent subshell,
 * external git client.
 *
 * The hook is a small bash script that shells out to `bkey approve` and
 * exits non-zero on denial. It is self-contained; the plugin writes it once
 * and the git runtime invokes it thereafter.
 */
object BKeyGitHook {
    private val log = Logger.getInstance(BKeyGitHook::class.java)
    private const val MANAGED_MARKER = "# managed-by: bkey-jetbrains-plugin"

    sealed class Status {
        object NotAGitRepo : Status()
        object NotInstalled : Status()
        object Installed : Status()
        data class ForeignHook(val firstLine: String) : Status()
    }

    sealed class InstallResult {
        object Installed : InstallResult()
        data class FailedForeignHook(val path: Path) : InstallResult()
        data class Error(val message: String) : InstallResult()
    }

    sealed class UninstallResult {
        object Removed : UninstallResult()
        object NotInstalled : UninstallResult()
        data class RefusedForeign(val path: Path) : UninstallResult()
        data class Error(val message: String) : UninstallResult()
    }

    fun status(repoPath: String): Status {
        val hook = hookPath(repoPath) ?: return Status.NotAGitRepo
        if (!Files.exists(hook)) return Status.NotInstalled
        val contents = runCatching { Files.readString(hook) }.getOrNull() ?: return Status.NotInstalled
        return if (contents.contains(MANAGED_MARKER)) {
            Status.Installed
        } else {
            Status.ForeignHook(contents.lineSequence().firstOrNull() ?: "")
        }
    }

    fun install(repoPath: String, overwrite: Boolean = false): InstallResult {
        val hook = hookPath(repoPath) ?: return InstallResult.Error("Not a git repository: $repoPath")

        Files.createDirectories(hook.parent)

        if (Files.exists(hook)) {
            val existing = runCatching { Files.readString(hook) }.getOrNull() ?: ""
            val ours = existing.contains(MANAGED_MARKER)
            if (!ours && !overwrite) {
                return InstallResult.FailedForeignHook(hook)
            }
            if (!ours && overwrite) {
                val backup = hook.resolveSibling("${hook.fileName}.bkey-backup")
                runCatching { Files.copy(hook, backup, StandardCopyOption.REPLACE_EXISTING) }
                    .onFailure { log.warn("Failed to back up existing commit-msg hook", it) }
            }
        }

        val settings = BKeySettings.getInstance()
        val script = buildHookScript(
            cliPath = settings.cliPath.ifBlank { "bkey" },
            scope = settings.scope.ifBlank { "approve:action" },
            profile = settings.agentProfile.ifBlank { null },
        )

        return try {
            Files.writeString(hook, script)
            makeExecutable(hook)
            InstallResult.Installed
        } catch (e: Exception) {
            log.warn("Failed to install commit-msg hook at $hook", e)
            InstallResult.Error(e.message ?: "unknown error")
        }
    }

    fun uninstall(repoPath: String): UninstallResult {
        val hook = hookPath(repoPath) ?: return UninstallResult.Error("Not a git repository: $repoPath")
        if (!Files.exists(hook)) return UninstallResult.NotInstalled

        val existing = runCatching { Files.readString(hook) }.getOrNull() ?: ""
        if (!existing.contains(MANAGED_MARKER)) {
            return UninstallResult.RefusedForeign(hook)
        }

        return try {
            Files.delete(hook)
            UninstallResult.Removed
        } catch (e: Exception) {
            log.warn("Failed to remove commit-msg hook at $hook", e)
            UninstallResult.Error(e.message ?: "unknown error")
        }
    }

    /**
     * Locate `.git/hooks/commit-msg` for a repo. Accepts both plain `.git/`
     * directories and `.git` files (worktrees / submodules) — in those cases
     * `.git` contains `gitdir: /absolute/path` which points at the real dir.
     */
    private fun hookPath(repoPath: String): Path? {
        val repo = Paths.get(repoPath)
        if (!Files.isDirectory(repo)) return null

        val gitMarker = repo.resolve(".git")
        if (!Files.exists(gitMarker)) return null

        val gitDir = when {
            Files.isDirectory(gitMarker) -> gitMarker
            Files.isRegularFile(gitMarker) -> {
                val contents = runCatching { Files.readString(gitMarker).trim() }.getOrNull() ?: return null
                val prefix = "gitdir:"
                if (!contents.startsWith(prefix)) return null
                val raw = contents.removePrefix(prefix).trim()
                val resolved = Paths.get(raw)
                if (resolved.isAbsolute) resolved else repo.resolve(raw).normalize()
            }
            else -> return null
        }

        return gitDir.resolve("hooks").resolve("commit-msg")
    }

    private fun makeExecutable(path: Path) {
        try {
            val perms = setOf(
                PosixFilePermission.OWNER_READ,
                PosixFilePermission.OWNER_WRITE,
                PosixFilePermission.OWNER_EXECUTE,
                PosixFilePermission.GROUP_READ,
                PosixFilePermission.GROUP_EXECUTE,
                PosixFilePermission.OTHERS_READ,
                PosixFilePermission.OTHERS_EXECUTE,
            )
            Files.setPosixFilePermissions(path, perms)
        } catch (_: UnsupportedOperationException) {
            // Non-POSIX filesystem (rare on macOS/Linux, possible on network mounts) — skip.
        }
    }

    private fun buildHookScript(cliPath: String, scope: String, profile: String?): String {
        val profileLine = if (profile != null) {
            "export BKEY_PROFILE=\"\${BKEY_PROFILE:-${escapeBash(profile)}}\""
        } else {
            "# BKEY_PROFILE unset — bkey picks the default agent profile"
        }
        return buildString {
            appendLine("#!/bin/bash")
            appendLine(MANAGED_MARKER)
            appendLine("# BKey commit-msg hook — biometric approval gate for every commit in this repo.")
            appendLine("# Fires whether the commit came from the IDE, a terminal, or an AI agent.")
            appendLine("#")
            appendLine("# Manage via JetBrains IDE → Settings → Tools → BKey Approval.")
            appendLine("# To remove manually: rm \${GIT_DIR:-.git}/hooks/commit-msg")
            appendLine()
            appendLine("set -euo pipefail")
            appendLine()
            appendLine("COMMIT_MSG_FILE=\"\${1:?commit-msg hook requires the message file path}\"")
            appendLine("COMMIT_MSG=\$(head -1 \"\$COMMIT_MSG_FILE\" | tr -d '\\r')")
            appendLine()
            appendLine("# Skip empty/comment-only first lines (merge commits, aborted edits).")
            appendLine("if [ -z \"\${COMMIT_MSG// }\" ] || [[ \"\$COMMIT_MSG\" =~ ^# ]]; then")
            appendLine("  exit 0")
            appendLine("fi")
            appendLine()
            appendLine("BKEY_BIN=\"\${BKEY_BIN:-${escapeBash(cliPath)}}\"")
            appendLine("BKEY_SCOPE=\"\${BKEY_SCOPE:-${escapeBash(scope)}}\"")
            appendLine(profileLine)
            appendLine("export BKEY_MODE=agent")
            appendLine()
            appendLine("if ! command -v \"\$BKEY_BIN\" >/dev/null 2>&1; then")
            appendLine("  echo \"bkey hook: '\$BKEY_BIN' not on PATH — skipping approval gate (commit proceeds).\" >&2")
            appendLine("  exit 0")
            appendLine("fi")
            appendLine()
            appendLine("PROFILE_ARGS=()")
            appendLine("[ -n \"\${BKEY_PROFILE:-}\" ] && PROFILE_ARGS+=(--profile \"\$BKEY_PROFILE\")")
            appendLine()
            appendLine("echo \"bkey hook: requesting approval for \\\"\$COMMIT_MSG\\\"…\" >&2")
            appendLine("RESULT=\$(\"\$BKEY_BIN\" approve \"\$COMMIT_MSG\" --scope \"\$BKEY_SCOPE\" \"\${PROFILE_ARGS[@]}\" --json 2>&1 || true)")
            appendLine()
            appendLine("if echo \"\$RESULT\" | grep -qE '\"approved\"[[:space:]]*:[[:space:]]*true'; then")
            appendLine("  echo \"bkey hook: approved.\" >&2")
            appendLine("  exit 0")
            appendLine("fi")
            appendLine()
            appendLine("echo \"bkey hook: commit BLOCKED — approval not granted.\" >&2")
            appendLine("echo \"\$RESULT\" >&2")
            appendLine("exit 1")
        }
    }

    private fun escapeBash(s: String): String =
        s.replace("\\", "\\\\").replace("\"", "\\\"").replace("$", "\\\$").replace("`", "\\`")
}
