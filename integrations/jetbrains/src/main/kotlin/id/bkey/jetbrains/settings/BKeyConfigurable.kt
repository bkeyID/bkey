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
    private val hookInstallButton = JButton("Install in all open projects")
    private val hookRemoveButton = JButton("Remove from all open projects")

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

    /** (displayName, basePath) for every open project that has a basePath. */
    private fun openProjectPaths(): List<Pair<String, String>> =
        ProjectManager.getInstance().openProjects
            .mapNotNull { p -> p.basePath?.let { p.name to it } }

    private fun refreshHookStatus() {
        val projects = openProjectPaths()
        if (projects.isEmpty()) {
            hookStatusLabel.text = "No open projects to manage."
            hookInstallButton.isEnabled = false
            hookRemoveButton.isEnabled = false
            return
        }

        val lines = mutableListOf<String>()
        var anyInstallable = false
        var anyRemovable = false
        for ((name, path) in projects) {
            val label = when (val status = BKeyGitHook.status(path)) {
                BKeyGitHook.Status.NotAGitRepo -> "not a git repo"
                BKeyGitHook.Status.NotInstalled -> { anyInstallable = true; "hook missing" }
                BKeyGitHook.Status.Installed -> { anyRemovable = true; "hook installed" }
                is BKeyGitHook.Status.ForeignHook -> "foreign hook — skip"
            }
            lines += "• $name — $label"
        }
        hookStatusLabel.text = "<html>" + lines.joinToString("<br>") + "</html>"
        hookInstallButton.isEnabled = anyInstallable
        hookRemoveButton.isEnabled = anyRemovable
    }

    private fun installHookInCurrentProject() {
        val projects = openProjectPaths()
        if (projects.isEmpty()) return
        val report = mutableListOf<String>()
        for ((name, path) in projects) {
            val line = when (val result = BKeyGitHook.install(path)) {
                BKeyGitHook.InstallResult.Installed -> "$name: installed"
                is BKeyGitHook.InstallResult.FailedForeignHook ->
                    "$name: skipped (foreign hook at ${result.path})"
                is BKeyGitHook.InstallResult.Error -> "$name: error — ${result.message}"
            }
            report += "• $line"
        }
        hookStatusLabel.text = "<html>" + report.joinToString("<br>") + "</html>"
        refreshHookStatus()
    }

    private fun removeHookFromCurrentProject() {
        val projects = openProjectPaths()
        if (projects.isEmpty()) return
        val report = mutableListOf<String>()
        for ((name, path) in projects) {
            val line = when (val result = BKeyGitHook.uninstall(path)) {
                BKeyGitHook.UninstallResult.Removed -> "$name: removed"
                BKeyGitHook.UninstallResult.NotInstalled -> "$name: no hook"
                is BKeyGitHook.UninstallResult.RefusedForeign ->
                    "$name: refused — foreign hook at ${result.path}"
                is BKeyGitHook.UninstallResult.Error -> "$name: error — ${result.message}"
            }
            report += "• $line"
        }
        hookStatusLabel.text = "<html>" + report.joinToString("<br>") + "</html>"
        refreshHookStatus()
    }
}
