package io.gotvh.tv.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Credentials
import okhttp3.FormBody
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

/** A Tvheadend request that failed, with a message meant for the viewer. */
class TvhException(message: String, val status: Int = 0) : Exception(message)

/**
 * Talks to Tvheadend's JSON API (the same API the web apps use).
 * Sign-in is HTTP Basic, sent with every request, including streams and channel icons.
 */
class TvhClient(server: String, val username: String, val password: String, val away: AwayAccess? = null) {

    /** At home: the server address as entered. Away: the front door (HTTPS, device certificate). */
    val base: String = away?.base ?: normalize(server)

    /** Connected through the front door from outside the home. */
    val isAway: Boolean get() = away != null
    val authHeader: String? = if (username.isNotEmpty()) Credentials.basic(username, password) else null

    /** Adds the sign-in to every request to this server (API calls, icons). */
    val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .addInterceptor { chain ->
            val req = chain.request()
            val auth = authHeader
            if (auth != null && req.header("Authorization") == null && req.url.toString().startsWith(base)) {
                chain.proceed(req.newBuilder().header("Authorization", auth).build())
            } else {
                chain.proceed(req)
            }
        }
        // Digest-only servers answer the Basic attempt with a challenge; this signs the retry.
        .authenticator(DigestAuthenticator(username, password))
        .apply { away?.let { sslSocketFactory(it.sslContext.socketFactory, it.trustManager) } }
        .build()

    /** Quick check that Tvheadend answers at [base] (a few seconds at most). */
    suspend fun reachable(): Boolean = withContext(Dispatchers.IO) {
        runCatching {
            http.newBuilder().connectTimeout(2, TimeUnit.SECONDS).callTimeout(4, TimeUnit.SECONDS).build()
                .newCall(Request.Builder().url("$base/api/serverinfo").build()).execute().use { it.isSuccessful }
        }.getOrDefault(false)
    }

    private var dvrConfig: String? = null

    // ------------------------------------------------------------------ requests

    private suspend fun get(path: String, params: Map<String, String> = emptyMap()): JSONObject =
        withContext(Dispatchers.IO) {
            val url = "$base/api/$path".toHttpUrl().newBuilder().apply {
                params.forEach { (k, v) -> addQueryParameter(k, v) }
            }.build()
            execute(Request.Builder().url(url).build())
        }

    private suspend fun post(path: String, form: Map<String, String>): JSONObject =
        withContext(Dispatchers.IO) {
            val body = FormBody.Builder().apply { form.forEach { (k, v) -> add(k, v) } }.build()
            execute(Request.Builder().url("$base/api/$path").post(body).build())
        }

    private fun execute(request: Request): JSONObject {
        http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                throw TvhException(describe(response.code, response.header("WWW-Authenticate")), response.code)
            }
            val text = response.body?.string().orEmpty().trim()
            return when {
                text.isEmpty() -> JSONObject()
                text.startsWith("[") -> JSONObject().put("entries", JSONArray(text))
                else -> JSONObject(text)
            }
        }
    }

    private fun describe(code: Int, challenge: String?): String = when {
        code == 401 -> "Wrong username or password."
        code == 403 -> "This account isn't allowed to use Tvheadend's API. Give it web interface and streaming rights."
        code == 404 -> "That address answered, but it isn't Tvheadend (no /api)."
        else -> "Tvheadend answered with an error ($code)."
    }

    // ------------------------------------------------------------------ API

    /** Proves the address and sign-in work. Returns e.g. "Tvheadend 4.3". */
    suspend fun serverInfo(): String {
        val info = get("serverinfo")
        return listOf(info.optString("name", "Tvheadend"), info.optString("sw_version")).filter { it.isNotBlank() }.joinToString(" ")
    }

    /** Switched-on channels, in channel-number order. */
    suspend fun channels(): List<Channel> {
        val entries = get("channel/grid", mapOf("start" to "0", "limit" to "5000")).optJSONArray("entries") ?: JSONArray()
        val out = ArrayList<Channel>(entries.length())
        for (i in 0 until entries.length()) {
            val o = entries.getJSONObject(i)
            if (o.has("enabled") && !o.optBoolean("enabled", true)) continue
            val number = o.opt("number")?.toString()?.takeUnless { it == "0" || it == "null" } ?: ""
            out += Channel(
                uuid = o.optString("uuid"),
                name = o.optString("name").ifBlank { "Channel" },
                number = number,
                icon = iconUrl(o.optString("icon_public_url")),
            )
        }
        return out.sortedWith(compareBy<Channel>({ numberKey(it.number).first }, { numberKey(it.number).second }, { it.name.lowercase() }))
    }

    /** Guide entries overlapping [fromSec, toSec), grouped by channel uuid and sorted by start. */
    suspend fun programs(fromSec: Long, toSec: Long): Map<String, List<Program>> {
        val filter = JSONArray()
            .put(JSONObject().put("field", "stop").put("type", "numeric").put("value", fromSec).put("comparison", "gt"))
            .put(JSONObject().put("field", "start").put("type", "numeric").put("value", toSec).put("comparison", "lt"))
        val entries = get(
            "epg/events/grid",
            mapOf("start" to "0", "limit" to "20000", "sort" to "start", "dir" to "ASC", "filter" to filter.toString()),
        ).optJSONArray("entries") ?: JSONArray()
        val out = HashMap<String, MutableList<Program>>()
        for (i in 0 until entries.length()) {
            val p = parseProgram(entries.getJSONObject(i))
            if (p.channelUuid.isNotEmpty() && p.stop > p.start) out.getOrPut(p.channelUuid) { mutableListOf() } += p
        }
        return out.mapValues { (_, list) -> list.sortedBy { it.start } }
    }

    /**
     * Programmes whose title matches [query] (and, with [fulltext], whose subtitle or description
     * does), on now or later, soonest first. Tvheadend searches its whole guide.
     */
    suspend fun search(query: String, fulltext: Boolean = true, limit: Int = 300): List<Program> {
        val q = query.trim()
        if (q.isEmpty()) return emptyList()
        // Tvheadend treats the text as a (case-insensitive) regular expression: match it literally.
        val special = ".^$*+?()[]{}|\\"
        val literal = buildString { q.forEach { c -> if (c in special) append('\\'); append(c) } }
        val params = mutableMapOf("title" to literal, "start" to "0", "limit" to limit.toString(), "sort" to "start", "dir" to "ASC")
        if (fulltext) params["fulltext"] = "1"
        val entries = get("epg/events/grid", params).optJSONArray("entries") ?: JSONArray()
        // Title matches first (what you're most likely after), then episode names / descriptions; soonest first in each.
        return List(entries.length()) { parseProgram(entries.getJSONObject(it)) }
            .filter { it.channelUuid.isNotEmpty() && it.stop > it.start }
            .sortedWith(compareBy<Program>({ !it.title.contains(q, ignoreCase = true) }, { it.start }))
    }

    private fun parseProgram(o: JSONObject): Program {
            val genres = o.optJSONArray("genre")
            return Program(
                eventId = o.optLong("eventId"),
                channelUuid = o.optString("channelUuid"),
                start = o.optLong("start"),
                stop = o.optLong("stop"),
                title = o.optString("title").ifBlank { "(no title)" },
                subtitle = o.optString("subtitle"),
                description = o.optString("description").ifBlank { o.optString("summary") },
                genre = if (genres == null) emptyList() else List(genres.length()) { genres.optInt(it) },
                dvrState = o.optString("dvrState"),
                dvrUuid = o.optString("dvrUuid"),
                seriesLink = o.optString("serieslinkUri"),
            )
    }

    /** Stream profile names the server offers ("pass", "webtv-h264-aac-mpegts", …). */
    suspend fun streamProfiles(): List<String> {
        val entries = get("profile/list").optJSONArray("entries") ?: return emptyList()
        return List(entries.length()) { entries.getJSONObject(it).optString("val") }.filter { it.isNotBlank() }
    }

    private suspend fun defaultDvrConfig(): String {
        dvrConfig?.let { return it }
        val entries = get("dvr/config/grid").optJSONArray("entries") ?: JSONArray()
        var uuid = ""
        for (i in 0 until entries.length()) {
            val o = entries.getJSONObject(i)
            if (uuid.isEmpty() || o.optString("name").isEmpty()) uuid = o.optString("uuid")
            if (o.optString("name").isEmpty()) break
        }
        return uuid.also { dvrConfig = it }
    }

    /**
     * Record [p]. Tvheadend answers create_by_event with an empty {} when it creates nothing (no
     * error), so check for the new entry; if there isn't one, record by channel and time instead.
     */
    suspend fun record(p: Program) {
        val config = defaultDvrConfig()
        if (createdSomething(post("dvr/entry/create_by_event", mapOf("event_id" to p.eventId.toString(), "config_uuid" to config)))) return
        val conf = JSONObject()
            .put("enabled", 1)
            .put("channel", p.channelUuid)
            .put("start", p.start)
            .put("stop", p.stop)
            .put("disp_title", p.title)
            .put("disp_subtitle", p.subtitle)
            .put("disp_description", p.description)
            .put("comment", "GoTVH")
        if (config.isNotEmpty()) conf.put("config_name", config)
        if (createdSomething(post("dvr/entry/create", mapOf("conf" to conf.toString())))) return
        throw TvhException("Tvheadend didn't create the recording. Check that this account may record (Users & access → Video recorder).")
    }

    /** Every episode, via the event's series link (becomes an auto-record rule). */
    suspend fun recordSeries(p: Program) {
        val reply = post("dvr/autorec/create_by_series", mapOf("event_id" to p.eventId.toString(), "config_uuid" to defaultDvrConfig()))
        if (!createdSomething(reply)) throw TvhException("Tvheadend couldn't make a series rule for “${p.title}” (the guide may not link its episodes).")
    }

    /** Tvheadend's create calls return {"uuid": …} (a string or a list) when they made something. */
    private fun createdSomething(reply: JSONObject): Boolean = when (val u = reply.opt("uuid")) {
        is String -> u.isNotBlank()
        is JSONArray -> u.length() > 0
        else -> false
    }

    suspend fun cancelRecording(dvrUuid: String) {
        post("dvr/entry/cancel", mapOf("uuid" to dvrUuid))
    }

    /** End a recording in progress, keeping the part already recorded. */
    suspend fun stopRecording(dvrUuid: String) {
        post("dvr/entry/stop", mapOf("uuid" to dvrUuid))
    }

    // ------------------------------------------------------------------ recordings

    suspend fun recordings(upcoming: Boolean): List<Recording> {
        val path = if (upcoming) "dvr/entry/grid_upcoming" else "dvr/entry/grid_finished"
        val entries = get(path, mapOf("start" to "0", "limit" to "5000")).optJSONArray("entries") ?: JSONArray()
        return List(entries.length()) { i ->
            val o = entries.getJSONObject(i)
            Recording(
                uuid = o.optString("uuid"),
                title = o.optString("disp_title").ifBlank { o.optString("title") }.ifBlank { "(no title)" },
                subtitle = o.optString("disp_subtitle").ifBlank { o.optString("disp_extratext") },
                description = o.optString("disp_description").ifBlank { o.optString("disp_summary") },
                channelName = o.optString("channelname"),
                start = o.optLong("start"),
                stop = o.optLong("stop"),
                filesize = o.optLong("filesize"),
                status = o.optString("status"),
                schedStatus = o.optString("sched_status"),
                playCount = o.optInt("playcount", 0),
                playPositionSec = o.optLong("playposition", 0),
            )
        }.filter { it.uuid.isNotEmpty() }
    }

    /**
     * Save watched state on the recording itself, where every device (and Kodi) reads it:
     * [playCount] times played to the end, [positionSec] where to resume (0 = start).
     */
    suspend fun setPlayState(uuid: String, playCount: Int, positionSec: Long) {
        post("idnode/save", mapOf("node" to JSONObject().put("uuid", uuid).put("playcount", playCount).put("playposition", positionSec).toString()))
    }

    /** Delete a finished recording and its file. */
    suspend fun removeRecording(uuid: String) {
        post("dvr/entry/remove", mapOf("uuid" to uuid))
    }

    /** The recorded file, streamed with seeking. */
    fun recordingUrl(uuid: String): String = "$base/dvrfile/$uuid"

    // ------------------------------------------------------------------ auto-record rules

    suspend fun autorecRules(): List<AutorecRule> {
        val entries = get("dvr/autorec/grid", mapOf("start" to "0", "limit" to "2000")).optJSONArray("entries") ?: JSONArray()
        return List(entries.length()) { i ->
            val o = entries.getJSONObject(i)
            AutorecRule(
                uuid = o.optString("uuid"),
                name = o.optString("name"),
                title = o.optString("title"),
                channelUuid = o.optString("channel"),
                enabled = o.optBoolean("enabled", true),
                comment = o.optString("comment"),
            )
        }.filter { it.uuid.isNotEmpty() }
    }

    suspend fun setEnabled(uuid: String, enabled: Boolean) {
        post("idnode/save", mapOf("node" to JSONObject().put("uuid", uuid).put("enabled", if (enabled) 1 else 0).toString()))
    }

    suspend fun deleteNode(uuid: String) {
        post("idnode/delete", mapOf("uuid" to uuid))
    }

    fun streamUrl(channelUuid: String, profile: String): String =
        "$base/stream/channel/$channelUuid?profile=${URLEncoder.encode(profile, "UTF-8")}"

    private fun iconUrl(raw: String): String? {
        val s = raw.trim()
        if (s.isEmpty()) return null
        if (s.startsWith("http://") || s.startsWith("https://")) return s
        return "$base/${s.trimStart('/')}"
    }

    companion object {
        /** "192.168.1.222:9981", "http://host:9981/", "http://host/tvh/api" → "http://host:9981" / "http://host/tvh". */
        fun normalize(server: String): String {
            var s = server.trim().trimEnd('/')
            if (!s.startsWith("http://") && !s.startsWith("https://")) s = "http://$s"
            if (s.endsWith("/api")) s = s.removeSuffix("/api")
            return s
        }

        /** "3.1" → (3, 1); "202" → (202, 0); "" → last. */
        fun numberKey(number: String): Pair<Int, Int> {
            val parts = number.split('.', '-')
            val major = parts.getOrNull(0)?.toIntOrNull() ?: Int.MAX_VALUE
            val minor = parts.getOrNull(1)?.toIntOrNull() ?: 0
            return major to minor
        }
    }
}
