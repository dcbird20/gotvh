package io.gotvh.tv.player

import androidx.media3.common.DataReader
import androidx.media3.common.Format
import androidx.media3.common.util.ParsableByteArray
import androidx.media3.common.util.UnstableApi
import androidx.media3.extractor.TrackOutput
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

@androidx.annotation.OptIn(UnstableApi::class)
class CaptionsTest {
    private class Sink : TrackOutput {
        val samples = mutableListOf<Pair<Long, ByteArray>>()
        private var pending = ByteArray(0)
        override fun format(format: Format) {}
        override fun sampleData(input: DataReader, length: Int, allowEndOfInput: Boolean, sampleDataPart: Int): Int = throw UnsupportedOperationException()
        override fun sampleData(data: ParsableByteArray, length: Int, sampleDataPart: Int) {
            pending += ByteArray(length).also { data.readBytes(it, 0, length) }
        }
        override fun sampleMetadata(timeUs: Long, flags: Int, size: Int, offset: Int, cryptoData: TrackOutput.CryptoData?) {
            samples += timeUs to pending
            pending = ByteArray(0)
        }
    }

    private fun bytes(vararg v: Int) = ByteArray(v.size) { v[it].toByte() }

    // cc_data: process flag + 2 entries, em_data, two 608 pairs, marker.
    private val ccTail = intArrayOf(0x42, 0xFF, 0xFC, 0x94, 0x20, 0xFC, 0x94, 0x2C, 0xFF)
    private val expected = bytes(0xFC, 0x94, 0x20, 0xFC, 0x94, 0x2C)

    @Test fun h264Sei() {
        val sei = intArrayOf(0xB5, 0x00, 0x31, 0x47, 0x41, 0x39, 0x34, 0x03) + ccTail
        val frame = bytes(0, 0, 0, 1, 0x09, 0xF0) + // access unit delimiter
            bytes(0, 0, 1, 0x06, 0x04, sei.size, *sei, 0x80) +
            bytes(0, 0, 1, 0x65, 0x88, 0x84) // a slice
        val sink = Sink()
        Captions.scan("H264", frame, 1234, arrayOf(sink))
        assertEquals(1, sink.samples.size)
        assertEquals(1234L, sink.samples[0].first)
        assertArrayEquals(expected, sink.samples[0].second)
    }

    @Test fun mpeg2UserData() {
        val frame = bytes(0, 0, 1, 0x00, 0x11, 0x22) + // picture header
            bytes(0, 0, 1, 0xB2, 0x47, 0x41, 0x39, 0x34, 0x03, *ccTail) +
            bytes(0, 0, 1, 0x01, 0x33) // a slice
        val sink = Sink()
        Captions.scan("MPEG2VIDEO", frame, 99, arrayOf(sink))
        assertEquals(1, sink.samples.size)
        assertArrayEquals(expected, sink.samples[0].second)
    }

    @Test fun noCaptions() {
        val sink = Sink()
        Captions.scan("H264", bytes(0, 0, 1, 0x65, 1, 2, 3), 0, arrayOf(sink))
        assertEquals(0, sink.samples.size)
    }
}
