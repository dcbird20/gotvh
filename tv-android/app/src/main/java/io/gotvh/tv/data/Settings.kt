package io.gotvh.tv.data

import android.content.Context

/** Server, sign-in and viewing preferences, kept in the app's private storage. */
class Settings(context: Context) {
    private val prefs = context.getSharedPreferences("gotvh", Context.MODE_PRIVATE)
    private val captioning = context.getSystemService(Context.CAPTIONING_SERVICE) as? android.view.accessibility.CaptioningManager

    /** Closed captions on. Until you choose, follows the TV's own Captions setting (Accessibility). */
    var captions: Boolean
        get() = if (prefs.contains("captions")) prefs.getBoolean("captions", false) else captioning?.isEnabled == true
        set(value) = prefs.edit().putBoolean("captions", value).apply()

    var server: String
        get() = prefs.getString("server", "") ?: ""
        set(value) = prefs.edit().putString("server", value).apply()

    var username: String
        get() = prefs.getString("username", "") ?: ""
        set(value) = prefs.edit().putString("username", value).apply()

    var password: String
        get() = prefs.getString("password", "") ?: ""
        set(value) = prefs.edit().putString("password", value).apply()

    /** Channel to start on: the one you were watching last. */
    var lastChannel: String
        get() = prefs.getString("lastChannel", "") ?: ""
        set(value) = prefs.edit().putString("lastChannel", value).apply()

    /** Tvheadend stream profile tried first ("pass" = the broadcast as-is). */
    /** Search also looks in programme descriptions (on by default: teams, actors are often only there). */
    var searchDescriptions: Boolean
        get() = prefs.getBoolean("searchDescriptions", true)
        set(value) = prefs.edit().putBoolean("searchDescriptions", value).apply()

    /** Away-from-home access from pairing (JSON, see [AwayAccess]); empty when not paired. */
    var away: String
        get() = prefs.getString("away", "") ?: ""
        set(value) = prefs.edit().putString("away", value).apply()

    /** Away from home: "auto" (original on Wi-Fi, converted on mobile data), "original" or "converted". */
    var awayQuality: String
        get() = prefs.getString("awayQuality", "auto") ?: "auto"
        set(value) = prefs.edit().putString("awayQuality", value).apply()

    /** The Tvheadend stream profile used when converting away from home (smaller stream). */
    var awayProfile: String
        // gotvh-away: H.264 + AAC-LC in Matroska. Tvheadend's own webtv-* profiles use AAC "Main",
        // which Android can't decode properly (garbled or refused), so the old default is moved over.
        get() = (prefs.getString("awayProfile", null) ?: AWAY_PROFILE).let { if (it == "webtv-h264-aac-mpegts") AWAY_PROFILE else it }
        set(value) = prefs.edit().putString("awayProfile", value).apply()

    var profile: String
        get() = prefs.getString("profile", "pass") ?: "pass"
        set(value) = prefs.edit().putString("profile", value).apply()

    val isConfigured: Boolean get() = server.isNotBlank()

    /** Where you stopped watching a recording (ms), so it can resume. 0 = from the start. */
    fun resumePosition(recordingUuid: String): Long = prefs.getLong("resume.$recordingUuid", 0L)

    fun saveResumePosition(recordingUuid: String, positionMs: Long) {
        prefs.edit().apply {
            if (positionMs <= 0) remove("resume.$recordingUuid") else putLong("resume.$recordingUuid", positionMs)
        }.apply()
    }

    companion object {
        /** The converting profile GoTVH sets up in Tvheadend for watching away from home. */
        const val AWAY_PROFILE = "gotvh-away"
    }
}
