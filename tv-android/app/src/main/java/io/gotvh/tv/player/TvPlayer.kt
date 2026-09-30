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
import io.gotvh.tv.data.Channel
import io.gotvh.tv.data.TvhClient

/**
 * Playback with Media3 (ExoPlayer), the engine most Android TV apps use.
 *
 * Live TV: Tvheadend streams MPEG-TS over HTTP. The first profile is normally "pass" (the broadcast
 * as-is). If this TV can't decode the picture (antenna channels are often MPEG-2), it moves on to the
 * next profile, which should be a Tvheadend profile that converts to H.264. Dolby AC-3 sound is
 * decoded in software (FFmpeg) when the TV has no decoder for it.
 *
 * Recordings: the file from Tvheadend's /dvrfile, with seeking, starting where you left off.
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

    private val main = Handler(Looper.getMainLooper())
    private var client: TvhClient? = null
    private var channel: Channel? = null
    private var profiles: List<String> = listOf("pass")
    private var profileIndex = 0
    private var retries = 0

    init {
        exo.playWhenReady = true
        exo.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_READY) {
                    tuning = false
                    retries = 0
                    if (profileIndex == 0) status = null
                }
                if (state == Player.STATE_ENDED && recordingUuid != null) ended = true
            }

            override fun onPlayerError(error: PlaybackException) = handleError(error)

            override fun onTracksChanged(tracks: Tracks) {
                if (recordingUuid != null) return
                // Sound this TV can't decode even with FFmpeg: try a converting profile.
                val hasAudio = tracks.groups.any { it.type == C.TRACK_TYPE_AUDIO }
                if (hasAudio && !tracks.isTypeSupported(C.TRACK_TYPE_AUDIO) && nextProfile()) {
                    status = "This TV can't play this channel's sound, so Tvheadend is converting it (${profiles[profileIndex]})."
                    start()
                }
            }
        })
    }

    /** Live TV. */
    fun play(client: TvhClient, channel: Channel, profiles: List<String>) {
        this.client = client
        this.channel = channel
        this.profiles = profiles.ifEmpty { listOf("pass") }
        recordingUuid = null
        ended = false
        profileIndex = 0
        retries = 0
        status = null
        start()
    }

    /** A recording, from [startMs] (0 = the beginning). */
    fun playRecording(client: TvhClient, uuid: String, startMs: Long) {
        main.removeCallbacksAndMessages(null)
        this.client = client
        channel = null
        recordingUuid = uuid
        ended = false
        retries = 0
        status = null
        startRecording(client, uuid, startMs)
    }

    private fun startRecording(client: TvhClient, uuid: String, startMs: Long) {
        tuning = true
        exo.setMediaSource(source(client, client.recordingUrl(uuid)), startMs.coerceAtLeast(0))
        exo.prepare()
        exo.play()
    }

    val isLive: Boolean get() = recordingUuid == null && channel != null

    fun stop() {
        main.removeCallbacksAndMessages(null)
        tuning = false
        exo.stop()
    }

    fun release() {
        main.removeCallbacksAndMessages(null)
        exo.release()
    }

    /** Streams go through the app's HTTP client, so they carry the same sign-in (Basic or Digest). */
    private fun source(client: TvhClient, url: String) =
        ProgressiveMediaSource.Factory(OkHttpDataSource.Factory(client.http))
            .createMediaSource(MediaItem.fromUri(url))

    private fun start() {
        val c = client ?: return
        val ch = channel ?: return
        main.removeCallbacksAndMessages(null)
        tuning = true
        exo.setMediaSource(source(c, c.streamUrl(ch.uuid, profiles[profileIndex])))
        exo.prepare()
        exo.play()
    }

    private fun nextProfile(): Boolean {
        if (profileIndex >= profiles.size - 1) return false
        profileIndex++
        return true
    }

    private fun handleError(error: PlaybackException) {
        tuning = false
        val code = generateSequence(error.cause) { it.cause }
            .filterIsInstance<HttpDataSource.InvalidResponseCodeException>()
            .firstOrNull()?.responseCode
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
            recording == null && decoderProblem && nextProfile() -> {
                status = "This TV can't decode this channel's picture, so Tvheadend is converting it (${profiles[profileIndex]})."
                start()
            }
            decoderProblem && recording != null -> status = "This TV can't decode this recording's video."
            decoderProblem -> status = "This TV can't decode this channel, and Tvheadend has no converting stream profile. " +
                "Add an H.264 profile in Tvheadend (Configuration → Stream → Stream profiles)."
            retries < 3 -> {
                retries++
                status = "Reconnecting…"
                val c = client
                if (recording != null && c != null) {
                    val at = exo.currentPosition
                    main.postDelayed({ startRecording(c, recording, at) }, 1500L * retries)
                } else {
                    main.postDelayed({ start() }, 1500L * retries)
                }
            }
            else -> status = "Playback stopped and didn't come back (${error.errorCodeName})."
        }
    }
}
