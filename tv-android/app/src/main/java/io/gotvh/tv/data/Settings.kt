package io.gotvh.tv.data

import android.content.Context

/** Server, sign-in and viewing preferences, kept in the app's private storage. */
class Settings(context: Context) {
    private val prefs = context.getSharedPreferences("gotvh", Context.MODE_PRIVATE)

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
    var profile: String
        get() = prefs.getString("profile", "pass") ?: "pass"
        set(value) = prefs.edit().putString("profile", value).apply()

    val isConfigured: Boolean get() = server.isNotBlank()
}
