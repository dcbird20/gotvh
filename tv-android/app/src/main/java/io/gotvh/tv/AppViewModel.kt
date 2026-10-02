package io.gotvh.tv

import android.app.Application
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import coil.ImageLoader
import io.gotvh.tv.data.AutorecRule
import io.gotvh.tv.data.Channel
import io.gotvh.tv.data.Program
import io.gotvh.tv.data.Recording
import io.gotvh.tv.data.Settings
import io.gotvh.tv.data.TvhClient
import io.gotvh.tv.data.TvhException
import io.gotvh.tv.player.TvPlayer
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.io.IOException

enum class Screen { Setup, Watch, Guide, Recordings, Rules, Playback, Search }

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
    /** Guide rows with placeholders filled in, per channel; cleared when the guide or channels reload. */
    private val filled = HashMap<String, List<Program>>()
    var screen by mutableStateOf(if (settings.isConfigured) Screen.Watch else Screen.Setup)
    var currentIndex by mutableIntStateOf(0)
        private set
    /** Channel row the guide opens on (the one you were watching, or picked in the channel list). */
    var guideRow by mutableIntStateOf(0)
    /** Channel watched before the current one (the remote's "last channel" key). */
    private var previousIndex = -1
    /** A short message for the viewer (connection problems, "Recording scheduled"). */
    var notice by mutableStateOf<String?>(null)
    /** The Menu-key menu (Live TV, Guide, Recordings, Auto-record, Settings). */
    var menuOpen by mutableStateOf(false)

    var recorded by mutableStateOf<List<Recording>>(emptyList())
        private set
    var upcoming by mutableStateOf<List<Recording>>(emptyList())
        private set
    var rules by mutableStateOf<List<AutorecRule>>(emptyList())
        private set
    /** The recording playing on the Playback screen. */
    var playing by mutableStateOf<Recording?>(null)
        private set
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
                filled.clear()
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
        if (screen == Screen.Playback) {
            val r = playing ?: return
            if (!player.exo.isPlaying && !player.tuning) player.playRecording(c, r.uuid, resumeMs(r), recordingUntil(r))
            return
        }
        val ch = currentChannel ?: return
        if (!player.exo.isPlaying && !player.tuning && !player.paused) player.play(c, ch, profiles)
    }

    /** Back to live TV from anywhere (restarts the channel if a recording was playing). */
    fun goLive() {
        menuOpen = false
        screen = Screen.Watch
        val c = client ?: return
        val ch = currentChannel ?: return
        if (!player.isLive) player.play(c, ch, profiles)
    }

    fun open(target: Screen) {
        menuOpen = false
        when (target) {
            Screen.Watch -> goLive()
            Screen.Guide -> {
                guideRow = currentIndex
                screen = Screen.Guide
            }
            Screen.Recordings -> {
                screen = Screen.Recordings
                loadRecordings()
            }
            Screen.Rules -> {
                screen = Screen.Rules
                loadRules()
            }
            Screen.Search -> {
                screen = Screen.Search
                loadRecordings() // recordings are searched too
            }
            else -> screen = target
        }
    }

    // ------------------------------------------------------------------ recordings

    fun loadRecordings() {
        val c = client ?: return
        viewModelScope.launch {
            pendingPlayState?.join()
            try {
                val finished = c.recordings(upcoming = false)
                upcoming = c.recordings(upcoming = true).sortedBy { it.start }
                // Recordings still being made are watchable too (from the start, following the file as it grows).
                val inProgress = upcoming.filter { it.isRecordingNow && finished.none { f -> f.uuid == it.uuid } }
                recorded = (finished + inProgress).sortedByDescending { it.start }
            } catch (e: TvhException) {
                notice = e.message
            } catch (e: IOException) {
                notice = "Couldn't reach Tvheadend."
            }
        }
    }

    /** Where to resume: Tvheadend's saved position, or this TV's own if the server couldn't store it. */
    fun resumeMs(r: Recording): Long = when {
        r.playPositionSec > 0 -> r.playPositionSec * 1000
        r.playCount == 0 -> settings.resumePosition(r.uuid)
        else -> 0
    }

    /** Play a recording from where you left off (or from the start). */
    fun playRecording(r: Recording, fromStart: Boolean) {
        val c = client ?: return
        playing = r
        countedPlay = null
        lastPushedSec = -1
        screen = Screen.Playback
        player.playRecording(c, r.uuid, if (fromStart) 0 else resumeMs(r), recordingUntil(r))
    }

    /** For a recording still being made: when it's due to end (Unix seconds); else 0. */
    private fun recordingUntil(r: Recording): Long = if (r.isRecordingNow) r.stop else 0

    /** This playback has already been counted as watched (so seeking around the end doesn't count twice). */
    private var countedPlay: String? = null
    private var lastPushedSec = -1L
    private var playStateWarned = false
    /** The last watched-state save, so a reload doesn't fetch the list before it lands. */
    private var pendingPlayState: kotlinx.coroutines.Job? = null

    /**
     * Remember where playback is. The first 15 s don't count (a peek leaves it as it was); the last
     * minute or the end counts as watched. Saved in Tvheadend every 30 s of change, and always when
     * [force]d (pause, leaving).
     */
    fun saveRecordingPosition(force: Boolean = false) {
        val r = playing ?: return
        val pos = player.exo.currentPosition
        val dur = player.exo.duration
        // A recording still being made isn't "finished" at the end of what's recorded so far.
        val finished = player.ended || (!player.growing && dur > 0 && pos > dur - 60_000)
        when {
            finished -> {
                if (countedPlay == r.uuid && r.playPositionSec == 0L) return
                val count = if (countedPlay == r.uuid) r.playCount else r.playCount + 1
                countedPlay = r.uuid
                setPlayState(r, count, 0)
            }
            pos < 15_000 -> return
            else -> {
                val sec = pos / 1000
                if (!force && lastPushedSec >= 0 && kotlin.math.abs(sec - lastPushedSec) < 30) return
                setPlayState(r, r.playCount, sec)
            }
        }
    }

    fun markWatched(r: Recording, watched: Boolean) {
        setPlayState(r, if (watched) maxOf(1, r.playCount) else 0, 0)
        notice = if (watched) "Marked “${r.title}” as watched" else "Marked “${r.title}” as unwatched"
    }

    /** Update the list at once, then store it in Tvheadend (and on this TV, in case the server refuses). */
    private fun setPlayState(r: Recording, count: Int, positionSec: Long) {
        val updated = r.copy(playCount = count, playPositionSec = positionSec)
        recorded = recorded.map { if (it.uuid == r.uuid) updated else it }
        if (playing?.uuid == r.uuid) playing = updated
        settings.saveResumePosition(r.uuid, positionSec * 1000)
        lastPushedSec = positionSec
        val c = client ?: return
        pendingPlayState = viewModelScope.launch {
            try {
                c.setPlayState(r.uuid, count, positionSec)
            } catch (e: TvhException) {
                if (!playStateWarned) notice = "Tvheadend didn’t save what you’ve watched (${e.message}). This TV will remember it instead."
                playStateWarned = true
            } catch (e: IOException) {
                // Kept on this TV; the next save tries again.
            }
        }
    }

    fun leavePlayback() {
        saveRecordingPosition(force = true)
        player.stop()
        playing = null
        screen = Screen.Recordings
        loadRecordings()
    }

    fun deleteRecording(r: Recording) = dvr("Deleted “${r.title}”", reloadRecordings = true) { it.removeRecording(r.uuid) }

    fun cancelUpcoming(r: Recording) = dvr("Won’t record “${r.title}”", reloadRecordings = true) {
        if (r.isRecordingNow) it.stopRecording(r.uuid) else it.cancelRecording(r.uuid)
    }

    // ------------------------------------------------------------------ auto-record rules

    fun loadRules() {
        val c = client ?: return
        viewModelScope.launch {
            try {
                rules = c.autorecRules().sortedBy { it.label.lowercase() }
            } catch (e: TvhException) {
                notice = e.message
            } catch (e: IOException) {
                notice = "Couldn't reach Tvheadend."
            }
        }
    }

    fun setRuleEnabled(rule: AutorecRule, enabled: Boolean) =
        dvr(if (enabled) "“${rule.label}” switched on" else "“${rule.label}” switched off", reloadRules = true) { it.setEnabled(rule.uuid, enabled) }

    fun deleteRule(rule: AutorecRule) = dvr("Deleted the rule “${rule.label}”", reloadRules = true) { it.deleteNode(rule.uuid) }

    fun channelName(uuid: String): String? = channels.firstOrNull { it.uuid == uuid }?.label

    // ------------------------------------------------------------------ search

    /** What's being searched for (title, subtitle or description). */
    var searchQuery by mutableStateOf("")
        private set
    /** Programmes in the guide that match, soonest first. */
    var searchResults by mutableStateOf<List<Program>>(emptyList())
        private set
    var searching by mutableStateOf(false)
        private set
    private var searchJob: kotlinx.coroutines.Job? = null

    /** Search the guide as you type (waits for a pause in typing). */
    fun search(query: String) {
        searchQuery = query
        searchJob?.cancel()
        val c = client ?: return
        if (query.trim().length < 2) {
            searchResults = emptyList()
            searching = false
            return
        }
        searchJob = viewModelScope.launch {
            delay(350)
            searching = true
            try {
                searchResults = c.search(query)
            } catch (e: TvhException) {
                notice = e.message
            } catch (e: IOException) {
                notice = "Couldn't reach Tvheadend."
            } finally {
                searching = false
            }
        }
    }

    /** Recordings (finished or in progress) whose title or subtitle matches the search. */
    fun searchRecordings(): List<Recording> {
        val q = searchQuery.trim()
        if (q.length < 2) return emptyList()
        return recorded.filter { it.title.contains(q, ignoreCase = true) || it.subtitle.contains(q, ignoreCase = true) }
    }

    // ------------------------------------------------------------------ guide

    /**
     * The guide row for a channel: its programmes, with every empty stretch filled by one-hour blocks
     * named after the channel (on the hour, trimmed to fit around real programmes). Placeholders are
     * only drawn here, never saved in Tvheadend, so real listings replace them as soon as they arrive.
     */
    fun programsFor(channelUuid: String): List<Program> {
        // Read both states every time so Compose redraws the row when either changes.
        val real = programs[channelUuid].orEmpty()
        val list = channels
        return filled.getOrPut(channelUuid) { withPlaceholders(channelUuid, real, list) }
    }

    /** Only what Tvheadend's guide lists (the banner and channel list use this). */
    private fun realPrograms(channelUuid: String): List<Program> = programs[channelUuid].orEmpty()

    private fun withPlaceholders(uuid: String, real: List<Program>, channels: List<Channel>): List<Program> {
        if (loadedTo <= loadedFrom) return real
        val name = channels.firstOrNull { it.uuid == uuid }?.name ?: "Channel"
        val out = ArrayList<Program>(real.size + 8)
        fun fill(from: Long, to: Long) {
            if (to - from < 120) return // a sliver between programmes isn't worth a tile
            var s = from
            while (s < to) {
                val e = minOf(s - Math.floorMod(s, 3600L) + 3600, to)
                out += Program(
                    eventId = -s, channelUuid = uuid, start = s, stop = e, title = name, subtitle = "",
                    description = "", genre = emptyList(), dvrState = "", dvrUuid = "", seriesLink = "", placeholder = true,
                )
                s = e
            }
        }
        var t = loadedFrom - Math.floorMod(loadedFrom, 3600L)
        for (p in real) {
            if (p.start > t) fill(t, p.start)
            out += p
            t = maxOf(t, p.stop)
        }
        fill(t, loadedTo)
        return out
    }

    fun nowAndNext(channelUuid: String, now: Long = nowSec()): Pair<Program?, Program?> {
        val list = realPrograms(channelUuid)
        val i = list.indexOfFirst { it.isAiring(now) }
        return if (i >= 0) list[i] to list.getOrNull(i + 1) else null to list.firstOrNull { it.start > now }
    }

    /** The next [count] programmes after the one on now. */
    fun upNext(channelUuid: String, count: Int, now: Long = nowSec()): List<Program> =
        realPrograms(channelUuid).filter { it.start > now }.take(count)

    /** Make sure the guide covers [from, to); loads more if not. */
    fun ensureGuide(from: Long, to: Long) {
        if (client == null || (from >= loadedFrom && to <= loadedTo)) return
        viewModelScope.launch { loadGuide(minOf(from, loadedFrom.takeIf { it > 0 } ?: from), maxOf(to, loadedTo)) }
    }

    private suspend fun loadGuide(from: Long, to: Long) {
        val c = client ?: return
        try {
            val fresh = c.programs(from, to)
            loadedFrom = from
            loadedTo = to
            filled.clear()
            programs = fresh
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

    fun record(p: Program, series: Boolean = false) =
        dvr(if (series) "Recording every episode of “${p.title}”" else "Recording “${p.title}”", reloadRecordings = true) {
            if (series) it.recordSeries(p) else it.record(p)
        }

    /** Not recording yet: remove it. Recording now: stop and keep what's recorded so far. */
    fun cancelRecording(p: Program) =
        if (p.isRecordingNow) dvr("Stopped recording “${p.title}”") { it.stopRecording(p.dvrUuid) }
        else dvr("Won’t record “${p.title}”") { it.cancelRecording(p.dvrUuid) }

    private fun dvr(done: String, reloadRecordings: Boolean = false, reloadRules: Boolean = false, action: suspend (TvhClient) -> Unit) {
        val c = client ?: return
        viewModelScope.launch {
            try {
                action(c)
                notice = done
                if (reloadRecordings) loadRecordings()
                if (reloadRules) loadRules()
                refreshGuide()
                // Search results show what's set to record: refresh them too.
                if (searchQuery.trim().length >= 2) runCatching { searchResults = c.search(searchQuery) }
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
