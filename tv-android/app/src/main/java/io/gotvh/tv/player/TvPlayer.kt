package io.gotvh.tv.player

import android.content.Context
import android.os.Handler
import android.os.Looper
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.HttpDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.media3.extractor.Extractor
import androidx.media3.extractor.ExtractorsFactory
import io.gotvh.tv.data.Channel
import io.gotvh.tv.data.TvhClient
import io.gotvh.tv.htsp.HtspChannels
import io.gotvh.tv.htsp.HtspException
import io.gotvh.tv.htsp.HtspSubscription
import java.util.concurrent.Executors

/**
 * Playback with Media3 (ExoPlayer).
 *
 * Live TV goes over HTSP (Tvheadend's own protocol, as Kodi uses) so it can be paused and rewound:
 * Tvheadend keeps the channel in its timeshift buffer, under its own timeshift settings. If HTSP
 * isn't available (port closed, account without HTSP rights), live TV falls back to the plain HTTP
 * stream, which plays but can't pause. If this TV can't decode a channel, it moves on to a
 * converting HTTP profile (H.264). Dolby AC-3 is decoded in software (FFmpeg) when needed.
 *
 * Recordings: the file from Tvheadend's /dvrfile, with seeking. A recording still in progress is
 * followed as it grows (the player reloads it when it nears the end of what's been recorded).
 */
@androidx.annotation.OptIn(UnstableApi::class)
class TvPlayer(context: Context) {

    val exo: ExoPlayer = ExoPlayer.Builder(context)
        .setRenderersFactory(
            DefaultRenderersFactory(context)
                .setEnableDecoderFallback(true)
                // The TV's own decoders first; FFmpeg (AC-3, E-AC-3, MP2…) only when it has none.
                .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_ON),
        )
        .build()

    /** A message for the viewer while something is wrong (null when playing normally). */
    var status by mutableStateOf<String?>(null)
        private set

    /** True from tuning until the first picture. */
    var tuning by mutableStateOf(false)
        private set

    /** Set while a recording (not live TV) is playing: its DVR uuid. */
    var recordingUuid by mutableStateOf<String?>(null)
        private set

    /** Playback reached the end of a recording. */
    var ended by mutableStateOf(false)
        private set

    /** The recording playing is still being recorded (its end keeps moving). */
    var growing by mutableStateOf(false)
        private set

    /** Live TV is paused (Tvheadend keeps recording into its timeshift buffer). */
    var paused by mutableStateOf(false)
        private set

    /** Why live TV can't be paused right now (null when it can, or when nothing is playing). */
    var pauseUnavailable by mutableStateOf<String?>(null)
        private set

    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor { r -> Thread(r, "tvplayer-io").apply { isDaemon = true } }
    private val htsp = HtspChannels()
    private var client: TvhClient? = null
    private var channel: Channel? = null
    private var profiles: List<String> = listOf("pass")
    private var profileIndex = 0
    private var retries = 0
    private var subscription: HtspSubscription? = null
    /** Live TV over HTTP (no pause): HTSP wasn't available, or this TV needs a converting profile. */
    private var httpLive = false
    private var playToken = 0
    private var growingStopSec = 0L
    private var lastGrowDurationMs = -1L

    init {
        exo.playWhenReady = true
        exo.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_READY) {
                    tuning = false
                    retries = 0
                    if (profileIndex == 0) status = null
                }
                if (state == Player.STATE_ENDED) {
                    when {
                        recordingUuid != null && growing -> refreshGrowing(force = true)
                        recordingUuid != null -> ended = true
                        channel != null -> retryLive("The channel stopped.")
                    }
                }
            }

            override fun onPlayerError(error: PlaybackException) = handleError(error)

            override fun onTracksChanged(tracks: Tracks) {
                if (recordingUuid != null) return
                // Sound this TV can't decode even with FFmpeg: try a converting profile.
                val hasAudio = tracks.groups.any { it.type == C.TRACK_TYPE_AUDIO }
                if (hasAudio && !tracks.isTypeSupported(C.TRACK_TYPE_AUDIO) && nextProfile()) {
                    status = "This TV can't play this channel's sound, so Tvheadend is converting it (${profiles[profileIndex]})."
                    startHttpLive()
                }
            }
        })
        tick()
    }

    // ------------------------------------------------------------------ live TV

    /** Live TV. */
    fun play(client: TvhClient, channel: Channel, profiles: List<String>) {
        stopSubscription()
        main.removeCallbacksAndMessages(TOKEN)
        this.client = client
        this.channel = channel
        this.profiles = profiles.ifEmpty { listOf("pass") }
        recordingUuid = null
        growing = false
        ended = false
        paused = false
        profileIndex = 0
        retries = 0
        status = null
        httpLive = false
        startLive()
    }

    val isLive: Boolean get() = recordingUuid == null && channel != null

    private fun startLive() {
        val c = client ?: return
        val ch = channel ?: return
        val token = ++playToken
        tuning = true
        exo.stop()
        io.execute {
            // HTSP first (pausable); the HTTP stream if it isn't available.
            val result = runCatching { htsp.channelId(c, ch) }
            main.post {
                if (token != playToken) return@post
                val id = result.getOrNull()
                if (id != null) {
                    pauseUnavailable = null
                    startHtsp(id)
                } else {
                    pauseUnavailable = (result.exceptionOrNull()?.message ?: "Tvheadend's HTSP connection isn't available") +
                        " — playing without pause."
                    startHttpLive()
                }
            }
        }
    }

    private fun startHtsp(channelId: Long) {
        val conn = htsp.connection ?: return startHttpLive()
        stopSubscription()
        val sub = HtspSubscription(conn, channelId, profile = null, timeshiftSeconds = TIMESHIFT_SECONDS)
        subscription = sub
        httpLive = false
        val source = ProgressiveMediaSource.Factory({ HtspDataSource(sub) }, ExtractorsFactory { arrayOf<Extractor>(HtspExtractor()) })
            .createMediaSource(MediaItem.fromUri("htsp://channel/$channelId"))
        exo.setMediaSource(source)
        exo.prepare()
        exo.playWhenReady = true
    }

    private fun startHttpLive() {
        val c = client ?: return
        val ch = channel ?: return
        stopSubscription()
        httpLive = true
        paused = false
        tuning = true
        exo.setMediaSource(httpSource(c, c.streamUrl(ch.uuid, profiles[profileIndex])))
        exo.prepare()
        exo.playWhenReady = true
    }

    private fun stopSubscription() {
        val sub = subscription ?: return
        subscription = null
        io.execute { sub.unsubscribe() }
    }

    /** Pausing works when live TV comes over HTSP and Tvheadend granted a timeshift buffer. */
    val canPause: Boolean get() = isLive && !httpLive && (subscription?.timeshiftAvailable ?: 0) > 0

    fun togglePause() = if (paused) resumeLive() else pauseLive()

    fun pauseLive() {
        val sub = subscription ?: return
        if (!canPause) {
            status = pauseUnavailable ?: "Tvheadend has no timeshift buffer for this channel, so it can't pause."
            later(4000) { if (!tuning) status = null }
            return
        }
        sub.speed(0)
        exo.playWhenReady = false
        paused = true
    }

    fun resumeLive() {
        subscription?.speed(100)
        exo.playWhenReady = true
        paused = false
    }

    /** Stream time of the live edge, ms (−1 if unknown). */
    private fun liveEdgeMs(): Long {
        val sub = subscription ?: return -1
        val edge = sub.liveEdgeMs()
        return if (edge >= 0) edge else exo.bufferedPosition
    }

    /** How far behind live the picture is, ms (0 at live). */
    val behindLiveMs: Long
        get() {
            if (!canPause) return 0
            val edge = liveEdgeMs()
            return if (edge < 0) 0 else (edge - exo.currentPosition).coerceAtLeast(0)
        }

    /** How much can be rewound right now, ms (what's in Tvheadend's timeshift buffer). */
    val liveBufferMs: Long
        get() {
            val sub = subscription ?: return 0
            if (!canPause) return 0
            val edge = liveEdgeMs()
            return if (edge < 0) 0 else (edge - sub.bufferStartUs / 1000).coerceAtLeast(0)
        }

    val isBehindLive: Boolean get() = behindLiveMs > LIVE_SLACK_MS

    /** Rewind (negative) or go forward in live TV. Forward past live just goes live. */
    fun seekLive(deltaMs: Long) {
        val sub = subscription ?: return
        if (!canPause) {
            pauseLive() // explains why not
            return
        }
        val edge = liveEdgeMs()
        val earliest = sub.bufferStartUs / 1000 + 2000
        val target = exo.currentPosition + deltaMs
        if (edge >= 0 && target >= edge - LIVE_SLACK_MS) return goLive()
        exo.seekTo(target.coerceAtLeast(earliest))
    }

    /** Back to the live picture. */
    fun goLive() {
        if (!canPause) return
        val edge = liveEdgeMs()
        if (edge >= 0) exo.seekTo((edge - 1500).coerceAtLeast(0))
        if (paused) resumeLive()
    }

    // ------------------------------------------------------------------ recordings

    /**
     * A recording, from [startMs] (0 = the beginning). [recordingUntilSec]: while the recording is
     * still being made, when it's due to end (Unix seconds), else 0.
     */
    fun playRecording(client: TvhClient, uuid: String, startMs: Long, recordingUntilSec: Long = 0) {
        main.removeCallbacksAndMessages(TOKEN)
        stopSubscription()
        playToken++
        this.client = client
        channel = null
        httpLive = false
        paused = false
        recordingUuid = uuid
        ended = false
        retries = 0
        status = null
        growingStopSec = recordingUntilSec
        growing = recordingUntilSec > 0
        lastGrowDurationMs = -1
        startRecording(client, uuid, startMs)
    }

    private fun startRecording(client: TvhClient, uuid: String, startMs: Long) {
        tuning = true
        exo.setMediaSource(httpSource(client, client.recordingUrl(uuid)), startMs.coerceAtLeast(0))
        exo.prepare()
        exo.play()
    }

    /**
     * A recording in progress only has what's been recorded so far. Near the end of that, reload it
     * (keeping the position) to pick up what's been added since.
     */
    private fun refreshGrowing(force: Boolean) {
        val c = client ?: return
        val uuid = recordingUuid ?: return
        if (!growing) return
        val dur = exo.duration
        val pos = exo.currentPosition
        val nearEnd = dur != C.TIME_UNSET && dur > 0 && pos > dur - 20_000
        if (!force && !nearEnd) return
        val nowSec = System.currentTimeMillis() / 1000
        // Finished recording (past its end, or nothing new since the last reload): play it out as is.
        if (nowSec > growingStopSec + 120 || (lastGrowDurationMs >= 0 && dur <= lastGrowDurationMs + 1000 && force)) {
            growing = false
            if (force) ended = true
            return
        }
        lastGrowDurationMs = dur
        val wasPlaying = exo.playWhenReady
        exo.setMediaSource(httpSource(c, c.recordingUrl(uuid)), pos)
        exo.prepare()
        exo.playWhenReady = wasPlaying
    }

    fun stop() {
        main.removeCallbacksAndMessages(TOKEN)
        playToken++
        stopSubscription()
        tuning = false
        paused = false
        exo.stop()
    }

    fun release() {
        stop()
        main.removeCallbacksAndMessages(null)
        exo.release()
        io.execute { htsp.close() }
        io.shutdown()
    }

    /** Streams and files go through the app's HTTP client, so they carry the same sign-in (Basic or Digest). */
    private fun httpSource(client: TvhClient, url: String) =
        ProgressiveMediaSource.Factory(OkHttpDataSource.Factory(client.http))
            .createMediaSource(MediaItem.fromUri(url))

    private fun nextProfile(): Boolean {
        if (profileIndex >= profiles.size - 1) return false
        profileIndex++
        return true
    }

    /** Every 2 s: follow growing recordings. */
    private fun tick() {
        main.postDelayed({
            if (recordingUuid != null && growing && exo.playbackState == Player.STATE_READY) refreshGrowing(force = false)
            tick()
        }, 2000)
    }

    /** Run on the main thread after [delayMs]; cancelled by the next play / stop. */
    private fun later(delayMs: Long, action: () -> Unit) {
        androidx.core.os.HandlerCompat.postDelayed(main, action, TOKEN, delayMs)
    }

    private fun retryLive(why: String) {
        if (retries >= 3) {
            status = "$why It didn't come back."
            return
        }
        retries++
        status = "Reconnecting…"
        later(1500L * retries) { if (channel != null && recordingUuid == null) (if (httpLive) startHttpLive() else startLive()) }
    }

    private fun handleError(error: PlaybackException) {
        tuning = false
        val causes = generateSequence(error.cause) { it.cause }.toList()
        val code = causes.filterIsInstance<HttpDataSource.InvalidResponseCodeException>().firstOrNull()?.responseCode
        val htspReason = causes.filterIsInstance<HtspException>().firstOrNull()?.message
        val decoderProblem = error.errorCode in setOf(
            PlaybackException.ERROR_CODE_DECODER_INIT_FAILED,
            PlaybackException.ERROR_CODE_DECODER_QUERY_FAILED,
            PlaybackException.ERROR_CODE_DECODING_FAILED,
            PlaybackException.ERROR_CODE_DECODING_FORMAT_EXCEEDS_CAPABILITIES,
            PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED,
        )
        val recording = recordingUuid
        when {
            code == 503 -> status = "No free tuner or stream right now: everything is in use (recordings, other viewers, or the IPTV stream limit)."
            code == 403 -> status = "Tvheadend won't stream this: it's switched off, or this account isn't allowed to watch it."
            code == 404 && recording != null -> status = "Tvheadend can't find this recording's file any more."
            code == 502 -> status = "Nothing is linked to this channel in Tvheadend. The admin app's channel check can relink it."
            code == 401 -> status = "Tvheadend rejected the sign-in. Check it under Settings."
            // HTSP live TV this TV can't decode: the converting HTTP profiles (no pause there).
            recording == null && decoderProblem && !httpLive -> {
                if (profiles.size > 1) profileIndex = 1
                status = if (profileIndex > 0) "This TV can't decode this channel's picture, so Tvheadend is converting it (${profiles[profileIndex]})." else null
                pauseUnavailable = "This channel needs converting for this TV, which plays without pause."
                startHttpLive()
            }
            recording == null && decoderProblem && nextProfile() -> {
                status = "This TV can't decode this channel's picture, so Tvheadend is converting it (${profiles[profileIndex]})."
                startHttpLive()
            }
            decoderProblem && recording != null -> status = "This TV can't decode this recording's video."
            decoderProblem -> status = "This TV can't decode this channel, and Tvheadend has no converting stream profile. " +
                "Add an H.264 profile in Tvheadend (Configuration → Stream → Stream profiles)."
            htspReason != null && recording == null -> retryLive(describeHtsp(htspReason))
            retries < 3 -> {
                retries++
                status = "Reconnecting…"
                val c = client
                if (recording != null && c != null) {
                    val at = exo.currentPosition
                    later(1500L * retries) { startRecording(c, recording, at) }
                } else {
                    later(1500L * retries) { if (httpLive) startHttpLive() else startLive() }
                }
            }
            else -> status = "Playback stopped and didn't come back (${error.errorCodeName})."
        }
    }

    /** Tvheadend's subscription errors, in plain words. */
    private fun describeHtsp(reason: String): String = when {
        reason.contains("adapter", true) || reason.contains("tuner", true) || reason.contains("input", true) ->
            "No free tuner or stream right now: everything is in use."
        reason.contains("access", true) || reason.contains("permission", true) -> "This account isn't allowed to watch this channel."
        reason.contains("lost", true) -> "Lost the connection to Tvheadend."
        else -> "Tvheadend: $reason."
    }

    companion object {
        private val TOKEN = Any()
        /** Ask for an hour of timeshift; Tvheadend grants up to its own maximum. */
        private const val TIMESHIFT_SECONDS = 3600
        /** Within this much of live counts as live. */
        const val LIVE_SLACK_MS = 8000L

    }
}
