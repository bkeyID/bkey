package id.bkey.jetbrains

import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity
import id.bkey.jetbrains.settings.BKeySettings

/**
 * Runs once per project on open. If the user has the auto-install toggle on,
 * drops a `commit-msg` hook into the project unless a foreign one is already
 * there (we never clobber a user's own hook without explicit `--overwrite`).
 *
 * Fires on a background thread — no UI blocking.
 */
class BKeyProjectStartup : ProjectActivity {
    private val log = Logger.getInstance(BKeyProjectStartup::class.java)

    override suspend fun execute(project: Project) {
        val settings = BKeySettings.getInstance()
        if (!settings.autoInstallGitHook) return
        val repoPath = project.basePath ?: return

        when (val status = BKeyGitHook.status(repoPath)) {
            BKeyGitHook.Status.NotAGitRepo -> {
                // Not git — nothing to do.
            }
            BKeyGitHook.Status.Installed -> {
                log.debug("BKey commit-msg hook already present in $repoPath")
            }
            BKeyGitHook.Status.NotInstalled -> {
                when (val result = BKeyGitHook.install(repoPath)) {
                    BKeyGitHook.InstallResult.Installed -> {
                        log.info("Auto-installed BKey commit-msg hook in $repoPath")
                        BKeyNotifications.info(
                            project,
                            "BKey commit-msg hook installed",
                            "Every commit in this project now requires BKey approval. Toggle off in Settings → Tools → BKey Approval.",
                        )
                    }
                    is BKeyGitHook.InstallResult.FailedForeignHook -> {
                        log.info("Skipped auto-install in $repoPath — foreign hook at ${result.path}")
                    }
                    is BKeyGitHook.InstallResult.Error -> {
                        log.warn("Auto-install failed in $repoPath: ${result.message}")
                    }
                }
            }
            is BKeyGitHook.Status.ForeignHook -> {
                log.info(
                    "Skipped auto-install in $repoPath — existing non-BKey commit-msg hook " +
                        "(first line: ${status.firstLine.take(80)})",
                )
            }
        }
    }
}
