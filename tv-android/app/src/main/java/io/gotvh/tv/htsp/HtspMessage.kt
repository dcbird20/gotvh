package io.gotvh.tv.htsp

import java.io.ByteArrayOutputStream
import java.io.IOException

/**
 * One HTSP message: Tvheadend's binary key/value format ("htsmsg").
 *
 * Wire format, after a 4-byte big-endian total length: fields of
 *   type (1 byte) · name length (1) · value length (4, big-endian) · name · value
 * Types: 1 map, 2 signed integer (little-endian, as few bytes as needed), 3 string, 4 binary, 5 list.
 * Lists are maps whose names are empty.
 *
 * Written from Tvheadend's HTSP documentation, with Kiall Mac Innes's android-htsp (Apache 2.0)
 * as the reference for the integer encoding.
 */
class HtspMessage(val fields: MutableMap<String, Any> = LinkedHashMap()) {

    constructor(method: String, vararg pairs: Pair<String, Any?>) : this() {
        fields["method"] = method
        for ((k, v) in pairs) if (v != null) fields[k] = v
    }

    operator fun set(key: String, value: Any?) {
        if (value == null) fields.remove(key) else fields[key] = value
    }

    fun has(key: String) = fields.containsKey(key)
    val method: String? get() = string("method")

    fun string(key: String): String? = when (val v = fields[key]) {
        null -> null
        is String -> v
        is ByteArray -> String(v, Charsets.UTF_8)
        else -> v.toString()
    }

    fun long(key: String): Long? = when (val v = fields[key]) {
        is Long -> v
        is Int -> v.toLong()
        is String -> v.toLongOrNull()
        else -> null
    }

    fun long(key: String, default: Long): Long = long(key) ?: default
    fun int(key: String): Int? = long(key)?.toInt()
    fun int(key: String, default: Int): Int = int(key) ?: default
    fun bytes(key: String): ByteArray? = fields[key] as? ByteArray

    @Suppress("UNCHECKED_CAST")
    fun list(key: String): List<Any> = (fields[key] as? List<Any>).orEmpty()

    fun messages(key: String): List<HtspMessage> = list(key).filterIsInstance<HtspMessage>()

    override fun toString(): String =
        fields.entries.joinToString(", ", "{", "}") { (k, v) -> "$k=" + if (v is ByteArray) "<${v.size} bytes>" else v.toString() }

    companion object {
        private const val MAP: Int = 1
        private const val S64: Int = 2
        private const val STR: Int = 3
        private const val BIN: Int = 4
        private const val LIST: Int = 5

        /** The whole message, length prefix included, ready to send. */
        fun encode(message: HtspMessage): ByteArray {
            val body = ByteArrayOutputStream()
            writeFields(body, message.fields.entries.map { it.key to it.value })
            val bytes = body.toByteArray()
            val out = ByteArrayOutputStream(bytes.size + 4)
            writeInt32(out, bytes.size)
            out.write(bytes)
            return out.toByteArray()
        }

        /** Decode a message body (without the 4-byte length prefix). */
        fun decode(data: ByteArray, offset: Int = 0, length: Int = data.size - offset): HtspMessage =
            HtspMessage(readFields(data, offset, length, isList = false) as MutableMap<String, Any>)

        private fun writeFields(out: ByteArrayOutputStream, fields: List<Pair<String, Any?>>) {
            for ((name, value) in fields) {
                if (value == null) continue
                val (type, bytes) = when (value) {
                    is String -> STR to value.toByteArray(Charsets.UTF_8)
                    is Int -> S64 to int64(value.toLong())
                    is Long -> S64 to int64(value)
                    is Boolean -> S64 to int64(if (value) 1 else 0)
                    is ByteArray -> BIN to value
                    is HtspMessage -> MAP to ByteArrayOutputStream().also { b -> writeFields(b, value.fields.entries.map { it.key to it.value }) }.toByteArray()
                    is Map<*, *> -> MAP to ByteArrayOutputStream().also { b -> writeFields(b, value.entries.map { it.key.toString() to it.value }) }.toByteArray()
                    is Iterable<*> -> LIST to ByteArrayOutputStream().also { b -> writeFields(b, value.map { "" to it }) }.toByteArray()
                    else -> throw IllegalArgumentException("Can't send a ${value::class.java.simpleName} over HTSP")
                }
                val nameBytes = name.toByteArray(Charsets.UTF_8)
                out.write(type)
                out.write(nameBytes.size and 0xFF)
                writeInt32(out, bytes.size)
                out.write(nameBytes)
                out.write(bytes)
            }
        }

        private fun readFields(data: ByteArray, offset: Int, length: Int, isList: Boolean): Any {
            val map = LinkedHashMap<String, Any>()
            val list = ArrayList<Any>()
            var p = offset
            val end = offset + length
            while (p < end) {
                if (end - p < 6) throw IOException("Truncated HTSP field")
                val type = data[p].toInt() and 0xFF
                val nameLen = data[p + 1].toInt() and 0xFF
                val valueLen = readInt32(data, p + 2)
                p += 6
                if (valueLen < 0 || p + nameLen + valueLen > end) throw IOException("Bad HTSP field length")
                val name = String(data, p, nameLen, Charsets.UTF_8)
                p += nameLen
                val value: Any = when (type) {
                    STR -> String(data, p, valueLen, Charsets.UTF_8)
                    S64 -> readInt64(data, p, valueLen)
                    BIN -> data.copyOfRange(p, p + valueLen)
                    MAP -> HtspMessage(readFields(data, p, valueLen, isList = false) as MutableMap<String, Any>)
                    LIST -> readFields(data, p, valueLen, isList = true)
                    else -> throw IOException("Unknown HTSP field type $type")
                }
                p += valueLen
                if (isList) list += value else map[name] = value
            }
            return if (isList) list else map
        }

        /** Little-endian, as few bytes as needed; negative numbers use all 8. */
        private fun int64(v: Long): ByteArray {
            if (v == 0L) return ByteArray(0)
            val n = if (v < 0) 8 else (64 - java.lang.Long.numberOfLeadingZeros(v) + 7) / 8
            return ByteArray(n) { i -> (v ushr (8 * i)).toByte() }
        }

        private fun readInt64(data: ByteArray, off: Int, len: Int): Long {
            var v = 0L
            for (i in 0 until minOf(len, 8)) v = v or ((data[off + i].toLong() and 0xFF) shl (8 * i))
            return v
        }

        private fun writeInt32(out: ByteArrayOutputStream, v: Int) {
            out.write(v ushr 24 and 0xFF)
            out.write(v ushr 16 and 0xFF)
            out.write(v ushr 8 and 0xFF)
            out.write(v and 0xFF)
        }

        fun readInt32(data: ByteArray, off: Int): Int =
            ((data[off].toInt() and 0xFF) shl 24) or ((data[off + 1].toInt() and 0xFF) shl 16) or
                ((data[off + 2].toInt() and 0xFF) shl 8) or (data[off + 3].toInt() and 0xFF)
    }
}
