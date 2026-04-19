package id.bkey.jetbrains.settings

import com.intellij.openapi.options.Configurable
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import javax.swing.JComponent
import javax.swing.JPanel

class BKeyConfigurable : Configurable {
    private var enabled = JBCheckBox("Require BKey approval for commits")
    private var includeDiffSummary = JBCheckBox("Include diff summary in approval prompt")
    private val cliPath = JBTextField()
    private val scope = JBTextField()
    private val timeoutSeconds = JBTextField()
    private val userDid = JBTextField()
    private val agentProfile = JBTextField()

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

        return FormBuilder.createFormBuilder()
            .addComponent(enabled)
            .addLabeledComponent("bkey CLI path:", cliPath)
            .addLabeledComponent("Agent profile (blank = CLI default):", agentProfile)
            .addLabeledComponent("Approval scope:", scope)
            .addLabeledComponent("Timeout (seconds):", timeoutSeconds)
            .addLabeledComponent("User DID (optional):", userDid)
            .addComponent(includeDiffSummary)
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
            agentProfile.text != s.agentProfile
    }

    override fun apply() {
        val s = BKeySettings.getInstance()
        s.enabled = enabled.isSelected
        s.includeDiffSummary = includeDiffSummary.isSelected
        s.cliPath = cliPath.text.trim().ifEmpty { "bkey" }
        s.scope = scope.text.trim().ifEmpty { "approve:git.commit" }
        s.timeoutSeconds = timeoutSeconds.text.trim().toIntOrNull()?.coerceIn(10, 900) ?: 120
        s.userDid = userDid.text.trim()
        s.agentProfile = agentProfile.text.trim()
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
    }
}
