package io.gotvh.tv.htsp

import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.Closeable
import java.io.DataInputStream
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Socket
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** Tvheadend refused something over HTSP (the text is Tvheadend's own, or ours for the viewer). */
class HtspException(message: String) : IOException(message)

/**
 * A connection to Tvheadend's HTSP port (9982 by default): the protocol Kodi uses, which unlike
 * HTTP streaming supports pausing and rewinding live TV (Tvheadend's timeshift).
 *
 * One reader thread receives everything. Replies are matched to requests by "seq"; messages for a
 * subscription go to its [Listener]; anything else (channel lists) to [onAsync].
 */
class HtspConnection private constructor(private val socket: Socket) : Closeable {

    /**
     * Receives messages that belong to one subscription, with the raw message [body] (so packets can
     * be handed on without encoding them again). Called on the reader thread: don't block.
     */
    fun interface Listener {
        fun onMessage(message: HtspMessage, body: ByteArray)
    }

    private val output = BufferedOutputStream(socket.getOutputStream(), 64 * 1024)
    private val input = DataInputStream(BufferedInputStream(socket.getInputStream(), 256 * 1024))
    private val seq = AtomicInteger(1)
    private val pending = ConcurrentHashMap<Long, LinkedBlockingQueue<HtspMessage>>()
    private val subscriptions = ConcurrentHashMap<Long, Listener>()
    private val nextSubscription = AtomicInteger(1)
    @Volatile var onAsync: ((HtspMessage) -> Unit)? = null
    @Volatile var closed = false
        private set
    @Volatile var failure: IOException? = null
        private set
    var htspVersion = 0
        private set

    private val reader = Thread({ readLoop() }, "htsp-reader").apply { isDaemon = true }

    private fun readLoop() {
        try {
            while (!closed) {
                val length = input.readInt()
                if (length < 0 || length > 64 * 1024 * 1024) throw IOException("Bad HTSP message length $length")
                val body = ByteArray(length)
                input.readFully(body)
                val msg = HtspMessage.decode(body)
                val replyTo = msg.long("seq")
                val queue = replyTo?.let { pending.remove(it) }
                when {
                    queue != null -> queue.offer(msg)
                    msg.has("subscriptionId") -> subscriptions[msg.long("subscriptionId")]?.onMessage(msg, body)
                    else -> onAsync?.invoke(msg)
                }
            }
        } catch (e: IOException) {
            if (!closed) failure = e
        } finally {
            closed = true
            runCatching { socket.close() }
            // Wake anyone waiting for a reply, and tell subscriptions the connection is gone.
            pending.values.forEach { it.offer(HtspMessage("error", "error" to "Connection to Tvheadend lost")) }
            val lost = HtspMessage("subscriptionStop", "status" to "Connection to Tvheadend lost")
            val lostBody = HtspMessage.encode(lost).let { it.copyOfRange(4, it.size) }
            subscriptions.values.forEach { it.onMessage(lost, lostBody) }
        }
    }

    private fun send(message: HtspMessage) {
        if (closed) throw HtspException("Not connected to Tvheadend")
        val bytes = HtspMessage.encode(message)
        synchronized(output) {
            output.write(bytes)
            output.flush()
        }
    }

    /** Send and wait for the reply. Throws if Tvheadend answers with an error. */
    fun request(message: HtspMessage, timeoutMs: Long = 8000): HtspMessage {
        val id = seq.getAndIncrement().toLong()
        val queue = LinkedBlockingQueue<HtspMessage>(1)
        pending[id] = queue
        message["seq"] = id
        try {
            send(message)
        } catch (e: IOException) {
            pending.remove(id)
            throw e
        }
        val reply = queue.poll(timeoutMs, TimeUnit.MILLISECONDS)
        pending.remove(id)
        reply ?: throw HtspException("Tvheadend didn't answer (${message.method})")
        if (reply.method == "error" || reply.has("error")) throw HtspException(reply.string("error") ?: "Tvheadend refused ${message.method}")
        if (reply.int("noaccess", 0) == 1) throw HtspException("This account isn't allowed to use HTSP")
        return reply
    }

    /** Send without waiting (pause, skip, …): the reader thread must never wait on itself. */
    fun post(message: HtspMessage) {
        message["seq"] = seq.getAndIncrement().toLong()
        send(message)
    }

    fun newSubscriptionId(): Long = nextSubscription.getAndIncrement().toLong()
    fun addSubscription(id: Long, listener: Listener) { subscriptions[id] = listener }
    fun removeSubscription(id: Long) { subscriptions.remove(id) }

    override fun close() {
        closed = true
        runCatching { socket.close() }
    }

    companion object {
        /**
         * Connect, say hello and sign in. Blocking: call off the main thread.
         * An empty [username] stays anonymous (works when Tvheadend allows it).
         */
        fun open(
            host: String, port: Int, username: String, password: String, clientName: String, clientVersion: String,
            /** Away from home: wraps the connection in TLS with the device certificate. */
            wrap: ((Socket) -> Socket)? = null,
        ): HtspConnection {
            val plain = Socket()
            val socket: Socket
            try {
                plain.tcpNoDelay = true
                plain.connect(InetSocketAddress(host, port), 5000)
                socket = wrap?.invoke(plain) ?: plain
            } catch (e: javax.net.ssl.SSLException) {
                runCatching { plain.close() }
                throw HtspException("The server refused this device away from home. Pair it again at home (Settings → Away from home).")
            } catch (e: IOException) {
                runCatching { plain.close() }
                throw HtspException("Can't reach Tvheadend's HTSP port ($host:$port)")
            }
            val c = HtspConnection(socket)
            c.reader.start()
            try {
                val hello = c.request(HtspMessage("hello", "htspversion" to 26, "clientname" to clientName, "clientversion" to clientVersion))
                c.htspVersion = hello.int("htspversion", 0)
                if (username.isNotEmpty()) {
                    val challenge = hello.bytes("challenge") ?: ByteArray(0)
                    val digest = MessageDigest.getInstance("SHA-1").run {
                        update(password.toByteArray(Charsets.UTF_8))
                        update(challenge)
                        digest()
                    }
                    c.request(HtspMessage("authenticate", "username" to username, "digest" to digest))
                }
                return c
            } catch (e: IOException) {
                c.close()
                throw e
            }
        }
    }
}
