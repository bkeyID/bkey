package id.bkey.jetbrains.settings

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.util.xmlb.XmlSerializerUtil

@State(
    name = "id.bkey.jetbrains.BKeySettings",
    storages = [Storage("bkey.xml")],
)
class BKeySettings : PersistentStateComponent<BKeySettings> {
    var enabled: Boolean = true
    var cliPath: String = "bkey"
    /**
     * CIBA scope requested when the plugin asks `bkey approve`. Must be in the
     * agent's `allowedScopes` set, which for the default `bkey auth setup-agent
     * --save` agent is just `approve:action`. Change to `approve:payment` or a
     * custom scope ONLY if the agent was created with that scope granted.
     */
    var scope: String = "approve:action"
    var timeoutSeconds: Int = 120
    var userDid: String = ""
    var includeDiffSummary: Boolean = true

    /**
     * Named agent profile in ~/.bkey/profiles.json (CLI ≥ 0.3.0). Empty means
     * "use the CLI's default agent profile". Multiple-agent setups put e.g.
     * `ide-agent` here; single-agent users can leave it blank.
     */
    var agentProfile: String = ""

    /**
     * When true, the plugin writes a `.git/hooks/commit-msg` script into every
     * git project it opens. That catches AI-agent commits issued through a
     * terminal subprocess (which bypass IntelliJ's VCS CheckinHandler), not
     * just commits going through the Commit dialog. Off by default because
     * it modifies files in the user's repo — opt-in per user.
     */
    var autoInstallGitHook: Boolean = false

    override fun getState(): BKeySettings = this

    override fun loadState(state: BKeySettings) {
        XmlSerializerUtil.copyBean(state, this)
        // One-shot migration: the pre-0.3.0 default was `approve:git.commit`,
        // which is not a scope the default `bkey auth setup-agent` agent is
        // granted (it gets `approve:action`). Auto-upgrade anyone still on the
        // old default; leave custom scopes alone.
        if (scope == "approve:git.commit") {
            scope = "approve:action"
        }
    }

    companion object {
        fun getInstance(): BKeySettings =
            ApplicationManager.getApplication().getService(BKeySettings::class.java)
    }
}
