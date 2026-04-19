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
    var scope: String = "approve:git.commit"
    var timeoutSeconds: Int = 120
    var userDid: String = ""
    var includeDiffSummary: Boolean = true

    /**
     * Named agent profile in ~/.bkey/profiles.json (CLI ≥ 0.3.0). Empty means
     * "use the CLI's default agent profile". Multiple-agent setups put e.g.
     * `ide-agent` here; single-agent users can leave it blank.
     */
    var agentProfile: String = ""

    override fun getState(): BKeySettings = this

    override fun loadState(state: BKeySettings) {
        XmlSerializerUtil.copyBean(state, this)
    }

    companion object {
        fun getInstance(): BKeySettings =
            ApplicationManager.getApplication().getService(BKeySettings::class.java)
    }
}
