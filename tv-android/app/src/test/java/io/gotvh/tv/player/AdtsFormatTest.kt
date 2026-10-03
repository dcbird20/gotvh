package io.gotvh.tv.player

import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

@androidx.annotation.OptIn(UnstableApi::class)
class AdtsFormatTest {
    // Described as 5.1 at 44.1 kHz (what the original broadcast had)...
    private val described = Format.Builder().setSampleMimeType(MimeTypes.AUDIO_AAC).setSampleRate(44100).setChannelCount(6).build()

    private fun bytes(vararg v: Int) = ByteArray(v.size) { v[it].toByte() }

    @Test fun frameHeaderWins() {
        // ...but the converter sends AAC-LC, 48 kHz, stereo: FFF1 4C 80 ...
        val f = HtspExtractor.adtsFormat(described, bytes(0xFF, 0xF1, 0x4C, 0x80, 0x2F, 0xFF, 0xFC, 0x21))!!
        assertEquals(48000, f.sampleRate)
        assertEquals(2, f.channelCount)
        assertArrayEquals(bytes(0x11, 0x90), f.initializationData[0])   // AudioSpecificConfig LC/48k/2ch
    }

    @Test fun noAdtsHeader() {
        assertNull(HtspExtractor.adtsFormat(described, bytes(0x21, 0x10, 0x04, 0x60, 0x8C, 0x1C, 0x00, 0x00)))
    }
}
