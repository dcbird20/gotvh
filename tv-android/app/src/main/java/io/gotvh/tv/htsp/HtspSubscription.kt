package io.gotvh.tv.htsp

import android.os.SystemClock
import java.io.IOException
import java.util.concurrent.LinkedBlockingDeque
import java.util.concurrent.TimeUnit

/**
 * One live channel over HTSP, with Tvheadend's timeshift: the server keeps the last
 * [timeshiftSeconds] of the channel, so it can be paused ([speed] 0), rewound ([skipTo]) and
 * returned to live — all done by the server, using its own timeshift settings.
 *
 * Packets ("muxpkt") and the stream description ("subscriptionStart") are queued, as raw HTSP
 * bodies, for the player to read through [take]. Timestamps start at 0 when the subscription starts
 * ("normts"), in microseconds, so the player's position is time since tuning.
 */
class HtspSubscription(
    private val connection: HtspConnection,
    val channelId: Long,
    private val profile: String?,
    private val timeshiftSeconds: Int,
) : HtspConnection.Listener {

    val id: Long = connection.newSubscriptionId()
    private val queue = LinkedBlockingDeque<ByteArray>()

    @Volatile var subscribed = false
        private set
    /** Seconds of timeshift Tvheadend granted (0 = it can't pause this channel). */
    @Volatile var timeshiftAvailable = 0
        private set
    /** Why the subscription ended ("No free adapter", …), or null while it runs. */
    @Volatile var stopReason: String? = null
        private set
    /** Tvheadend's latest status text for this subscription (problems only), e.g. "No input source available". */
    @Volatile var status: String? = null
        private set

    // Timeshift status, in µs of stream time; [statusAt] is when it arrived (elapsedRealtime ms).
    @Volatile var bufferStartUs: Long = 0
        private set
    @Volatile var liveEndUs: Long = -1
        private set
    @Volatile private var statusAt: Long = 0
    @Volatile private var skipping = false
    @Volatile private var paused = false

    /** Start receiving the channel. Blocking (call off the main thread); throws with Tvheadend's reason. */
    fun subscribe() {
        if (subscribed) return
        connection.addSubscription(id, this)
        val reply = try {
            connection.request(
                HtspMessage(
                    "subscribe",
                    "subscriptionId" to id,
                    "channelId" to channelId,
                    "timeshiftPeriod" to timeshiftSeconds,
                    "normts" to 1,
                    "profile" to profile,
                ),
            )
        } catch (e: IOException) {
            connection.removeSubscription(id)
            throw e
        }
        timeshiftAvailable = reply.int("timeshiftPeriod", 0)
        subscribed = true
    }

    override fun onMessage(message: HtspMessage, body: ByteArray) {
        when (message.method) {
            "subscriptionStart" -> queue.offer(body)
            "muxpkt" -> if (!skipping) queue.offer(body)
            "subscriptionSkip" -> {
                // The jump has happened: packets from here on are from the new point.
                queue.clear()
                skipping = false
            }
            "timeshiftStatus" -> {
                bufferStartUs = message.long("start") ?: bufferStartUs
                message.long("end")?.let { liveEndUs = it }
                statusAt = SystemClock.elapsedRealtime()
            }
            "subscriptionStatus" -> status = message.string("subscriptionError") ?: message.string("status")
            "subscriptionStop" -> stopReason = message.string("status") ?: "Tvheadend stopped the channel"
        }
    }

    /** The next queued message body, or null if none arrived within [timeoutMs]. */
    fun take(timeoutMs: Long): ByteArray? = queue.poll(timeoutMs, TimeUnit.MILLISECONDS)

    /** Nothing more is coming. */
    val ended: Boolean get() = stopReason != null && queue.isEmpty()

    /** The live edge right now (stream time, ms), or -1 before Tvheadend has reported it. */
    fun liveEdgeMs(): Long {
        if (liveEndUs < 0) return -1
        // The edge keeps moving between status messages (also while paused: Tvheadend keeps recording).
        return liveEndUs / 1000 + (SystemClock.elapsedRealtime() - statusAt)
    }

    /** Jump to [timeUs] of stream time. Packets still in flight from before are dropped. */
    fun skipTo(timeUs: Long) {
        queue.clear()
        skipping = true
        runCatching {
            connection.post(HtspMessage("subscriptionSkip", "subscriptionId" to id, "time" to timeUs.coerceAtLeast(0), "absolute" to 1))
        }.onFailure { skipping = false }
    }

    /** 0 = pause (Tvheadend keeps recording into the timeshift buffer), 100 = normal. */
    fun speed(percent: Int) {
        paused = percent == 0
        runCatching { connection.post(HtspMessage("subscriptionSpeed", "subscriptionId" to id, "speed" to percent)) }
    }

    fun unsubscribe() {
        connection.removeSubscription(id)
        if (subscribed) runCatching { connection.post(HtspMessage("unsubscribe", "subscriptionId" to id)) }
        subscribed = false
        if (stopReason == null) stopReason = "Stopped"
        queue.clear()
    }
}
