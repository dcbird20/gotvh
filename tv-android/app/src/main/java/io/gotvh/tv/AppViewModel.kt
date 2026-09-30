package io.gotvh.tv

import android.app.Application
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import coil.ImageLoader
import io.gotvh.tv.data.Channel
import io.gotvh.tv.data.Program
import io.gotvh.tv.data.Settings
import io.gotvh.tv.data.TvhClient
import io.gotvh.tv.data.TvhException
import io.gotvh.tv.player.TvPlayer
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.io.IOException

enum class Screen { Setup, Watch, Guide }

fun nowSec(): Long = System.currentTimeMillis() / 1000

class AppViewModel(app: Application) : AndroidViewModel(app) {

    val settings = Settings(app)
    val player = TvPlayer(app)

    var client by mutableStateOf<TvhClient?>(null)
        private set
    /** Loads channel logos with the Tvheadend sign-in (its image cache needs it). */
    var imageLoader by mutableStateOf<ImageLoader?>(null)
        private set
    var channels by mutableStateOf<List<Channel>>(emptyList())
        private set
    var programs by mutableStateOf<Map<String, List<Program>>>(emptyMap())
        private set
    var screen by mutableStateOf(if (settings.isConfigured) Screen.Watch else Screen.Setup)
    var currentIndex by mutableIntStateOf(0)
        private set
    /** Channel row the guide opens on (the one you were watching, or picked in the channel list). */
    var guideRow by mutableIntStateOf(0)
    /** Channel watched before the current one (the remote's "last channel" key). */
    private var previousIndex = -1
    /** A short message for the viewer (connection problems, "Recording scheduled"). */
    var notice by mutableStateOf<String?>(null)
    var loading by mutableStateOf(false)
        private set

    private var profiles: List<String> = listOf("pass")
    private var loadedFrom = 0L
    private var loadedTo = 0L

    val currentChannel: Channel? get() = channels.getOrNull(currentIndex)

    init {
        if (settings.isConfigured) connect()
        // Keep the guide's recording marks and "now" data fresh.
        viewModelScope.launch {
            while (true) {
                delay(5 * 60_000L)
                if (client != null) refreshGuide()
            }
        }
    }

    private fun connect() {
        val c = TvhClient(settings.server, settings.username, settings.password)
        client = c
        imageLoader = ImageLoader.Builder(getApplication()).okHttpClient(c.http).build()
        viewModelScope.launch {
            loading = true
            try {
                channels = c.channels()
                profiles = playbackProfiles(c)
                val last = channels.indexOfFirst { it.uuid == settings.lastChannel }
                currentIndex = if (last >= 0) last else 0
                if (screen == Screen.Watch) currentChannel?.let { player.play(c, it, profiles) }
                val now = nowSec()
                loadGuide(now - 3600, now + 12 * 3600)
            } catch (e: TvhException) {
                notice = e.message
            } catch (e: IOException) {
                notice = "Can't reach Tvheadend at ${c.base}. Check the address under Settings (Menu in the guide)."
            } finally {
                loading = false
            }
        }
    }

    /** The preferred profile first, then any H.264 profile the server has, as a fallback for codecs the TV can't play. */
    private suspend fun playbackProfiles(c: TvhClient): List<String> {
        val server = runCatching { c.streamProfiles() }.getOrDefault(emptyList())
        val preferred = settings.profile
        val converting = server.filter { it != preferred && Regex("h264|avc|x264", RegexOption.IGNORE_CASE).containsMatchIn(it) }
            .sortedBy { if (it.contains("mpegts", ignoreCase = true)) 0 else 1 }
        return listOf(preferred) + converting
    }

    /** Check the address and sign-in; on success save them and start watching. Returns an error message or null. */
    suspend fun testAndSave(server: String, username: String, password: String): String? {
        val c = TvhClient(server, username, password)
        return try {
            c.serverInfo()
            if (c.channels().isEmpty()) return "Connected, but Tvheadend has no switched-on channels yet. Set them up in the admin app."
            settings.server = c.base
            settings.username = username
            settings.password = password
            screen = Screen.Watch
            connect()
            null
        } catch (e: TvhException) {
            e.message
        } catch (e: IOException) {
            "Can't reach ${c.base} (${e.message}). Check the address and port, e.g. http://192.168.1.222:9981"
        } catch (e: IllegalArgumentException) {
            "That doesn't look like an address. Try something like http://192.168.1.222:9981"
        }
    }

    // ------------------------------------------------------------------ watching

    fun tune(index: Int) {
        val c = client ?: return
        if (channels.isEmpty()) return
        val i = Math.floorMod(index, channels.size)
        if (i != currentIndex) previousIndex = currentIndex
        currentIndex = i
        val ch = channels[i]
        settings.lastChannel = ch.uuid
        player.play(c, ch, profiles)
    }

    fun tuneUuid(uuid: String) {
        val i = channels.indexOfFirst { it.uuid == uuid }
        if (i >= 0) tune(i)
    }

    fun tunePrevious() {
        if (previousIndex >= 0) tune(previousIndex)
    }

    /** Channel for typed digits: exact number, else the first "23.x" for "23". */
    fun indexForNumber(digits: String): Int {
        val exact = channels.indexOfFirst { it.number == digits }
        if (exact >= 0) return exact
        return channels.indexOfFirst { it.number.substringBefore('.') == digits }
    }

    fun resumeIfStopped() {
        val c = client ?: return
        val ch = currentChannel ?: return
        if (!player.exo.isPlaying && !player.tuning) player.play(c, ch, profiles)
    }

    // ------------------------------------------------------------------ guide

    fun programsFor(channelUuid: String): List<Program> = programs[channelUuid].orEmpty()

    fun nowAndNext(channelUuid: String, now: Long = nowSec()): Pair<Program?, Program?> {
        val list = programsFor(channelUuid)
        val i = list.indexOfFirst { it.isAiring(now) }
        return if (i >= 0) list[i] to list.getOrNull(i + 1) else null to list.firstOrNull { it.start > now }
    }

    /** Make sure the guide covers [from, to); loads more if not. */
    fun ensureGuide(from: Long, to: Long) {
        if (client == null || (from >= loadedFrom && to <= loadedTo)) return
        viewModelScope.launch { loadGuide(minOf(from, loadedFrom.takeIf { it > 0 } ?: from), maxOf(to, loadedTo)) }
    }

    private suspend fun loadGuide(from: Long, to: Long) {
        val c = client ?: return
        try {
            programs = c.programs(from, to)
            loadedFrom = from
            loadedTo = to
        } catch (e: TvhException) {
            notice = e.message
        } catch (e: IOException) {
            // Keep what we have; the next refresh tries again.
        }
    }

    private suspend fun refreshGuide() {
        if (loadedTo > loadedFrom) {
            val now = nowSec()
            loadGuide(minOf(loadedFrom, now - 3600), maxOf(loadedTo, now + 12 * 3600))
        }
    }

    fun record(p: Program, series: Boolean = false) = dvr(if (series) "Recording every episode of “${p.title}”" else "Recording “${p.title}”") {
        if (series) it.recordSeries(p.eventId) else it.record(p.eventId)
    }

    /** Not recording yet: remove it. Recording now: stop and keep what's recorded so far. */
    fun cancelRecording(p: Program) =
        if (p.isRecordingNow) dvr("Stopped recording “${p.title}”") { it.stopRecording(p.dvrUuid) }
        else dvr("Won’t record “${p.title}”") { it.cancelRecording(p.dvrUuid) }

    private fun dvr(done: String, action: suspend (TvhClient) -> Unit) {
        val c = client ?: return
        viewModelScope.launch {
            try {
                action(c)
                notice = done
                refreshGuide()
            } catch (e: TvhException) {
                notice = e.message
            } catch (e: IOException) {
                notice = "Couldn't reach Tvheadend."
            }
        }
    }

    override fun onCleared() {
        player.release()
    }
}
