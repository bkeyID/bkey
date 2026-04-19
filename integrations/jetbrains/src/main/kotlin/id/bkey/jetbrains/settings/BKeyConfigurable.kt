package id.bkey.jetbrains.settings

import com.intellij.openapi.options.Configurable
import com.intellij.openapi.project.ProjectManager
import com.intellij.ui.TitledSeparator
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import id.bkey.jetbrains.BKeyGitHook
import java.awt.BorderLayout
import java.awt.FlowLayout
import javax.swing.BoxLayout
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel

class BKeyConfigurable : Configurable {
    private val enabled = JBCheckBox("Require BKey approval for commits")
    private val includeDiffSummary = JBCheckBox("Include diff summary in approval prompt")
    private val cliPath = JBTextField()
    private val scope = JBTextField()
    private val timeoutSeconds = JBTextField()
    private val userDid = JBTextField()
    private val agentProfile = JBTextField()

    private val autoInstallHook = JBCheckBox(
        "Auto-install commit-msg hook in every opened git project",
    )
    private val hookStatusLabel = JLabel(" ")
    private val hookInstallButton = JButton("Install in current project")
    private val hookRemoveButton = JButton("Remove from current project")

    override fun getDisplayName() = "BKey Approval"

    override fun createComponent(): JComponent {
        val settings = BKeySettings.getInstance()
        enabled.isSelected = settings.enabled
        includeDiffSummary.isSelected = settings.includeDiffSummary
        cliPath.text = settings.cliPath
        scope.text = settings.scope
        timeoutSeconds.text = settings.timeoutSeconds.toString()
        userDid.text = settings.userDid
        agentProfile.text = settings.agentProfile
        autoInstallHook.isSelected = settings.autoInstallGitHook

        hookInstallButton.addActionListener { installHookInCurrentProject() }
        hookRemoveButton.addActionListener { removeHookFromCurrentProject() }

        val hookButtons = JPanel(FlowLayout(FlowLayout.LEFT, 0, 0)).apply {
            add(hookInstallButton)
            add(JLabel("  "))
            add(hookRemoveButton)
        }

        val hookSection = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            add(autoInstallHook)
            add(hookButtons)
            add(hookStatusLabel)
        }

        refreshHookStatus()

        return FormBuilder.createFormBuilder()
            .addComponent(enabled)
            .addLabeledComponent("bkey CLI path:", cliPath)
            .addLabeledComponent("Agent profile (blank = CLI default):", agentProfile)
            .addLabeledComponent("Approval scope:", scope)
            .addLabeledComponent("Timeout (seconds):", timeoutSeconds)
            .addLabeledComponent("User DID (optional):", userDid)
            .addComponent(includeDiffSummary)
            .addComponent(TitledSeparator("Git commit-msg hook (catches agent/terminal commits)"))
            .addComponent(hookSection)
            .addComponentFillVertically(JPanel(), 0)
            .panel
    }

    override fun isModified(): Boolean {
        val s = BKeySettings.getInstance()
        return enabled.isSelected != s.enabled ||
            includeDiffSummary.isSelected != s.includeDiffSummary ||
            cliPath.text != s.cliPath ||
            scope.text != s.scope ||
            timeoutSeconds.text != s.timeoutSeconds.toString() ||
            userDid.text != s.userDid ||
            agentProfile.text != s.agentProfile ||
            autoInstallHook.isSelected != s.autoInstallGitHook
    }

    override fun apply() {
        val s = BKeySettings.getInstance()
        s.enabled = enabled.isSelected
        s.includeDiffSummary = includeDiffSummary.isSelected
        s.cliPath = cliPath.text.trim().ifEmpty { "bkey" }
        s.scope = scope.text.trim().ifEmpty { "approve:action" }
        s.timeoutSeconds = timeoutSeconds.text.trim().toIntOrNull()?.coerceIn(10, 900) ?: 120
        s.userDid = userDid.text.trim()
        s.agentProfile = agentProfile.text.trim()
        s.autoInstallGitHook = autoInstallHook.isSelected
    }

    override fun reset() {
        val s = BKeySettings.getInstance()
        enabled.isSelected = s.enabled
        includeDiffSummary.isSelected = s.includeDiffSummary
        cliPath.text = s.cliPath
        scope.text = s.scope
        timeoutSeconds.text = s.timeoutSeconds.toString()
        userDid.text = s.userDid
        agentProfile.text = s.agentProfile
        autoInstallHook.isSelected = s.autoInstallGitHook
        refreshHookStatus()
    }

    private fun currentProjectPath(): String? {
        val project = ProjectManager.getInstance().openProjects.firstOrNull() ?: return null
        return project.basePath
    }

    private fun refreshHookStatus() {
        val path = currentProjectPath()
        if (path == null) {
            hookStatusLabel.text = "No open project to manage."
            hookInstallButton.isEnabled = false
            hookRemoveButton.isEnabled = false
            return
        }
        when (val status = BKeyGitHook.status(path)) {
            BKeyGitHook.Status.NotAGitRepo -> {
                hookStatusLabel.text = "Current project is not a git repository."
                hookInstallButton.isEnabled = false
                hookRemoveButton.isEnabled = false
            }
            BKeyGitHook.Status.NotInstalled -> {
                hookStatusLabel.text = "Hook not installed in: $path"
                hookInstallButton.isEnabled = true
                hookRemoveButton.isEnabled = false
            }
            BKeyGitHook.Status.Installed -> {
                hookStatusLabel.text = "Hook installed in: $path"
                hookInstallButton.isEnabled = false
                hookRemoveButton.isEnabled = true
            }
            is BKeyGitHook.Status.ForeignHook -> {
                hookStatusLabel.text =
                    "A non-BKey commit-msg hook already exists in: $path — leaving it alone."
                hookInstallButton.isEnabled = false
                hookRemoveButton.isEnabled = false
            }
        }
    }

    private fun installHookInCurrentProject() {
        val path = currentProjectPath() ?: return
        when (val result = BKeyGitHook.install(path)) {
            BKeyGitHook.InstallResult.Installed -> hookStatusLabel.text = "Installed in: $path"
            is BKeyGitHook.InstallResult.FailedForeignHook ->
                hookStatusLabel.text = "A non-BKey hook already exists at ${result.path}."
            is BKeyGitHook.InstallResult.Error ->
                hookStatusLabel.text = "Failed to install: ${result.message}"
        }
        refreshHookStatus()
    }

    private fun removeHookFromCurrentProject() {
        val path = currentProjectPath() ?: return
        when (val result = BKeyGitHook.uninstall(path)) {
            BKeyGitHook.UninstallResult.Removed -> hookStatusLabel.text = "Removed from: $path"
            BKeyGitHook.UninstallResult.NotInstalled -> hookStatusLabel.text = "Hook was not installed."
            is BKeyGitHook.UninstallResult.RefusedForeign ->
                hookStatusLabel.text = "Refused: hook at ${result.path} is not managed by BKey."
            is BKeyGitHook.UninstallResult.Error ->
                hookStatusLabel.text = "Failed to remove: ${result.message}"
        }
        refreshHookStatus()
    }
}
