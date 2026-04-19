package id.bkey.jetbrains

import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.execution.process.CapturingProcessHandler
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.progress.ProgressIndicator
import id.bkey.jetbrains.settings.BKeySettings
import java.nio.charset.StandardCharsets

sealed class BKeyApprovalResult {
    data class Approved(val scope: String, val expiresIn: Int) : BKeyApprovalResult()
    data class Denied(val reason: String) : BKeyApprovalResult()
    data class Error(val message: String) : BKeyApprovalResult()
}

object BKeyCliRunner {
    private val log = Logger.getInstance(BKeyCliRunner::class.java)

    fun approve(
        bindingMessage: String,
        indicator: ProgressIndicator?,
        workingDirectory: String? = null,
    ): BKeyApprovalResult {
        val settings = BKeySettings.getInstance()

        val cmd = GeneralCommandLine().apply {
            exePath = settings.cliPath
            addParameters("approve", bindingMessage, "--scope", settings.scope, "--json")
            addParameters("--timeout", settings.timeoutSeconds.toString())
            if (settings.userDid.isNotBlank()) {
                addParameters("--user-did", settings.userDid)
            }
            if (workingDirectory != null) {
                setWorkDirectory(workingDirectory)
            }
            charset = StandardCharsets.UTF_8
        }

        return try {
            val handler = CapturingProcessHandler(cmd)
            indicator?.text = "Waiting for BKey approval on your phone…"
            indicator?.isIndeterminate = true
            val output = handler.runProcessWithProgressIndicator(
                indicator ?: com.intellij.openapi.progress.EmptyProgressIndicator(),
                (settings.timeoutSeconds + 30) * 1000,
            )

            if (output.isTimeout) {
                handler.destroyProcess()
                return BKeyApprovalResult.Error("Approval request timed out after ${settings.timeoutSeconds}s")
            }

            if (output.isCancelled) {
                return BKeyApprovalResult.Error("Approval cancelled")
            }

            val stdout = output.stdout.trim()
            val stderr = output.stderr.trim()

            val approved = stdout.contains("\"approved\": true") || stdout.contains("\"approved\":true")

            if (output.exitCode == 0 && approved) {
                BKeyApprovalResult.Approved(
                    scope = parseJsonField(stdout, "scope") ?: settings.scope,
                    expiresIn = parseJsonField(stdout, "expires_in")?.toIntOrNull() ?: 0,
                )
            } else {
                val reason = parseJsonField(stdout, "error")
                    ?: stderr.ifBlank { "bkey exited with code ${output.exitCode}" }
                log.info("BKey approval denied: $reason")
                BKeyApprovalResult.Denied(reason)
            }
        } catch (e: Exception) {
            log.warn("Failed to run bkey CLI", e)
            BKeyApprovalResult.Error(
                "Could not run '${settings.cliPath}': ${e.message ?: "unknown error"}. " +
                    "Is the bkey CLI installed and on PATH? Configure a full path in Settings → Tools → BKey Approval."
            )
        }
    }

    private fun parseJsonField(json: String, key: String): String? {
        val regex = Regex("\"$key\"\\s*:\\s*(?:\"([^\"]*)\"|([0-9]+))")
        val m = regex.find(json) ?: return null
        return m.groupValues[1].ifEmpty { m.groupValues[2] }.ifEmpty { null }
    }
}
