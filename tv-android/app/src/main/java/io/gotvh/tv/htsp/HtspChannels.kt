package io.gotvh.tv.htsp

import io.gotvh.tv.data.Channel
import io.gotvh.tv.data.TvhClient
import java.net.URI
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The app's HTSP connection, and which HTSP channel number goes with each channel the app knows
 * (HTSP identifies channels by a number; the rest of the app uses Tvheadend's uuids).
 * Blocking calls: use from a background thread.
 */
class HtspChannels {

    private class Entry(val id: Long, val uuid: String?, val name: String, val number: String)

    @Volatile var connection: HtspConnection? = null
        private set
    private var key = ""
    private val channels = ConcurrentHashMap<Long, Entry>()

    /** HTSP's id for [channel], connecting first if needed. Throws with a reason for the viewer. */
    @Synchronized
    fun channelId(client: TvhClient, channel: Channel): Long {
        ensureConnected(client)
        val all = channels.values
        all.firstOrNull { it.uuid != null && it.uuid == channel.uuid }?.let { return it.id }
        val sameName = all.filter { it.name == channel.name }
        sameName.firstOrNull { it.number == channel.number }?.let { return it.id }
        sameName.singleOrNull()?.let { return it.id }
        if (channel.number.isNotEmpty()) all.singleOrNull { it.number == channel.number }?.let { return it.id }
        sameName.firstOrNull()?.let { return it.id }
        throw HtspException("“${channel.name}” isn't offered over HTSP")
    }

    private fun ensureConnected(client: TvhClient) {
        val away = client.away
        val (host, port) = if (away != null) away.htspHost to away.port else htspAddress(client.base)
        val k = "$host:$port:${client.username}"
        val current = connection
        if (current != null && !current.closed && key == k) return
        close()
        val synced = CountDownLatch(1)
        val conn = HtspConnection.open(host, port, client.username, client.password, "GoTVH", "1",
            wrap = away?.let { a -> { socket: java.net.Socket -> a.wrap(socket, host) } })
        conn.onAsync = { msg ->
            when (msg.method) {
                "channelAdd", "channelUpdate" -> {
                    val id = msg.long("channelId")
                    if (id != null) {
                        val old = channels[id]
                        val major = msg.long("channelNumber")
                        val minor = msg.long("channelNumberMinor")
                        val number = when {
                            major == null -> old?.number ?: ""
                            major == 0L -> ""
                            minor != null && minor > 0 -> "$major.$minor"
                            else -> "$major"
                        }
                        channels[id] = Entry(id, msg.string("channelUuid") ?: old?.uuid, msg.string("channelName") ?: old?.name ?: "", number)
                    }
                }
                "channelDelete" -> msg.long("channelId")?.let { channels.remove(it) }
                "initialSyncCompleted" -> synced.countDown()
            }
        }
        channels.clear()
        // Channels only (no guide): the reply comes at once, the channel list follows.
        conn.request(HtspMessage("enableAsyncMetadata", "epg" to 0), timeoutMs = 20_000)
        synced.await(15, TimeUnit.SECONDS)
        connection = conn
        key = k
    }

    fun close() {
        connection?.close()
        connection = null
        key = ""
    }

    companion object {
        /**
         * Where HTSP is: the same host as the web interface, on the next port up for Tvheadend's
         * usual ports (9981 → 9982, 9983 → 9984), else Tvheadend's default 9982.
         */
        fun htspAddress(base: String): Pair<String, Int> {
            val uri = URI(base)
            val host = uri.host ?: base
            val http = uri.port
            val port = if (http in 9980..9999) http + 1 else 9982
            return host to port
        }
    }
}
