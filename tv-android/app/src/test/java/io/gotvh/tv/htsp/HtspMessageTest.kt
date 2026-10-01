package io.gotvh.tv.htsp

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class HtspMessageTest {

    private fun roundTrip(m: HtspMessage): HtspMessage {
        val bytes = HtspMessage.encode(m)
        assertEquals(bytes.size - 4, HtspMessage.readInt32(bytes, 0))
        return HtspMessage.decode(bytes, 4, bytes.size - 4)
    }

    @Test
    fun integersStringsAndBinary() {
        val m = roundTrip(HtspMessage("hello", "htspversion" to 26, "big" to 5_000_000_000L, "neg" to -2L, "zero" to 0, "bin" to byteArrayOf(1, 2, 3), "name" to "GoTVH ✓"))
        assertEquals("hello", m.method)
        assertEquals(26L, m.long("htspversion"))
        assertEquals(5_000_000_000L, m.long("big"))
        assertEquals(-2L, m.long("neg"))
        assertEquals(0L, m.long("zero"))
        assertArrayEquals(byteArrayOf(1, 2, 3), m.bytes("bin"))
        assertEquals("GoTVH ✓", m.string("name"))
    }

    @Test
    fun integersAreLittleEndianAndMinimal() {
        // S64 300 = 0x012C → bytes 2C 01
        val bytes = HtspMessage.encode(HtspMessage(mutableMapOf<String, Any>("n" to 300L)))
        // length(4) type(1) namelen(1) valuelen(4) name(1) value(2)
        assertEquals(2, bytes[4].toInt())
        assertEquals(2, HtspMessage.readInt32(bytes, 6))
        assertEquals(0x2C, bytes[11].toInt() and 0xFF)
        assertEquals(0x01, bytes[12].toInt() and 0xFF)
    }

    @Test
    fun nestedListsAndMaps() {
        val stream = HtspMessage(mutableMapOf<String, Any>("index" to 1L, "type" to "H264"))
        val m = roundTrip(HtspMessage("subscriptionStart", "streams" to listOf(stream, HtspMessage(mutableMapOf<String, Any>("index" to 2L, "type" to "AC3"))), "nums" to listOf(1L, 2L)))
        val streams = m.messages("streams")
        assertEquals(2, streams.size)
        assertEquals("H264", streams[0].string("type"))
        assertEquals(2, streams[1].int("index"))
        assertEquals(listOf<Any>(1L, 2L), m.list("nums"))
    }
}
