package id.bkey.jetbrains

import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vcs.CheckinProjectPanel
import com.intellij.openapi.vcs.changes.CommitContext
import com.intellij.openapi.vcs.checkin.CheckinHandler
import com.intellij.openapi.vcs.ui.RefreshableOnComponent
import com.intellij.ui.components.JBCheckBox
import id.bkey.jetbrains.settings.BKeySettings
import java.awt.BorderLayout
import javax.swing.JComponent
import javax.swing.JPanel

class BKeyCheckinHandler(
    private val panel: CheckinProjectPanel,
    private val commitContext: CommitContext,
) : CheckinHandler() {

    private val skipCheckbox = JBCheckBox("Skip BKey approval for this commit (human override)")

    override fun getBeforeCheckinConfigurationPanel(): RefreshableOnComponent {
        val wrapper = JPanel(BorderLayout()).apply { add(skipCheckbox, BorderLayout.WEST) }
        return object : RefreshableOnComponent {
            override fun getComponent(): JComponent = wrapper
            override fun saveState() {}
            override fun restoreState() {
                skipCheckbox.isSelected = false
            }
        }
    }

    override fun beforeCheckin(): ReturnResult {
        val settings = BKeySettings.getInstance()
        if (!settings.enabled) return ReturnResult.COMMIT
        if (skipCheckbox.isSelected) return ReturnResult.COMMIT

        val bindingMessage = buildBindingMessage(settings.includeDiffSummary)
        val project = panel.project
        val workingDir = project.basePath

        val resultHolder = arrayOf<BKeyApprovalResult?>(null)
        val title = "Waiting for BKey approval"

        val completed = ProgressManager.getInstance().runProcessWithProgressSynchronously(
            {
                val indicator = ProgressManager.getInstance().progressIndicator
                indicator?.isIndeterminate = true
                indicator?.text = title
                indicator?.text2 = "Check your phone and approve with Face ID"
                resultHolder[0] = BKeyCliRunner.approve(
                    bindingMessage = bindingMessage,
                    indicator = indicator,
                    workingDirectory = workingDir,
                )
            },
            title,
            true,
            project,
        )

        if (!completed) {
            BKeyNotifications.warn(project, "Commit cancelled", "BKey approval was cancelled before completing.")
            return ReturnResult.CANCEL
        }

        return when (val result = resultHolder[0]) {
            is BKeyApprovalResult.Approved -> {
                BKeyNotifications.info(project, "Approved", "BKey approval granted. Proceeding with commit.")
                ReturnResult.COMMIT
            }
            is BKeyApprovalResult.Denied -> {
                Messages.showErrorDialog(
                    project,
                    "BKey approval was denied:\n\n${result.reason}",
                    "Commit Blocked by BKey",
                )
                ReturnResult.CANCEL
            }
            is BKeyApprovalResult.Error -> {
                Messages.showErrorDialog(
                    project,
                    "Could not complete BKey approval:\n\n${result.message}",
                    "BKey Approval Error",
                )
                ReturnResult.CANCEL
            }
            null -> ReturnResult.CANCEL
        }
    }

    private fun buildBindingMessage(includeDiffSummary: Boolean): String {
        val commitMessage = panel.commitMessage.trim().ifEmpty { "(no commit message)" }
        val firstLine = commitMessage.lineSequence().first().take(120)
        if (!includeDiffSummary) return firstLine

        val changes = panel.selectedChanges
        val fileCount = changes.size
        val files = changes.asSequence()
            .mapNotNull { it.virtualFile?.name ?: it.afterRevision?.file?.name ?: it.beforeRevision?.file?.name }
            .take(3)
            .toList()
        val fileSummary = when {
            fileCount == 0 -> ""
            files.size < fileCount -> " [$fileCount files: ${files.joinToString(", ")}, …]"
            else -> " [${files.joinToString(", ")}]"
        }
        return (firstLine + fileSummary).take(200)
    }
}
