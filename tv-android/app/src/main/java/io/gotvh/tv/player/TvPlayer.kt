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
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.HttpDataSource
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import io.gotvh.tv.data.Channel
import io.gotvh.tv.data.TvhClient

/**
 * Live TV playback with Media3 (ExoPlayer), the engine most Android TV apps use.
 *
 * Tvheadend streams MPEG-TS over HTTP. The first profile is normally "pass" (the broadcast as-is).
 * If this TV can't decode the picture or the sound (antenna channels are often MPEG-2 video with
 * Dolby AC-3 audio), it moves on to the next profile, which should be a Tvheadend profile that
 * converts to H.264/AAC.
 */
@androidx.annotation.OptIn(UnstableApi::class)
class TvPlayer(context: Context) {

    val exo: ExoPlayer = ExoPlayer.Builder(context)
        .setRenderersFactory(DefaultRenderersFactory(context).setEnableDecoderFallback(true))
        .build()

    /** A message for the viewer while something is wrong (null when playing normally). */
    var status by mutableStateOf<String?>(null)
        private set

    /** True from tuning until the first picture. */
    var tuning by mutableStateOf(false)
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
            }

            override fun onPlayerError(error: PlaybackException) = handleError(error)

            override fun onTracksChanged(tracks: Tracks) {
                // Sound this TV can't decode (typically Dolby AC-3): try a converting profile.
                val hasAudio = tracks.groups.any { it.type == C.TRACK_TYPE_AUDIO }
                if (hasAudio && !tracks.isTypeSupported(C.TRACK_TYPE_AUDIO) && nextProfile()) {
                    status = "This TV can't play this channel's sound, so Tvheadend is converting it (${profiles[profileIndex]})."
                    start()
                }
            }
        })
    }

    fun play(client: TvhClient, channel: Channel, profiles: List<String>) {
        this.client = client
        this.channel = channel
        this.profiles = profiles.ifEmpty { listOf("pass") }
        profileIndex = 0
        retries = 0
        status = null
        start()
    }

    fun stop() {
        main.removeCallbacksAndMessages(null)
        tuning = false
        exo.stop()
    }

    fun release() {
        main.removeCallbacksAndMessages(null)
        exo.release()
    }

    private fun start() {
        val c = client ?: return
        val ch = channel ?: return
        main.removeCallbacksAndMessages(null)
        tuning = true
        val http = DefaultHttpDataSource.Factory()
            .setConnectTimeoutMs(10_000)
            .setReadTimeoutMs(20_000)
            .setAllowCrossProtocolRedirects(true)
        c.authHeader?.let { http.setDefaultRequestProperties(mapOf("Authorization" to it)) }
        val source = ProgressiveMediaSource.Factory(http)
            .createMediaSource(MediaItem.fromUri(c.streamUrl(ch.uuid, profiles[profileIndex])))
        exo.setMediaSource(source)
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
        when {
            code == 503 -> status = "No free tuner or stream right now: everything is in use (recordings, other viewers, or the IPTV stream limit)."
            code == 403 -> status = "Tvheadend won't stream this channel: it's switched off, or this account isn't allowed to watch it."
            code == 502 -> status = "Nothing is linked to this channel in Tvheadend. The admin app's channel check can relink it."
            code == 401 -> status = "Tvheadend rejected the sign-in. Check it under Settings (Menu in the guide)."
            decoderProblem && nextProfile() -> {
                status = "This TV can't decode this channel's picture, so Tvheadend is converting it (${profiles[profileIndex]})."
                start()
            }
            decoderProblem -> status = "This TV can't decode this channel, and Tvheadend has no converting stream profile. " +
                "Add an H.264 profile in Tvheadend (Configuration → Stream → Stream profiles)."
            retries < 3 -> {
                retries++
                status = "Reconnecting…"
                main.postDelayed({ start() }, 1500L * retries)
            }
            else -> status = "The stream stopped and didn't come back (${error.errorCodeName})."
        }
    }
}
