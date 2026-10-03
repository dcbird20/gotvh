package io.gotvh.tv.player

import android.net.Uri
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.ParsableByteArray
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.BaseDataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.extractor.AacUtil
import androidx.media3.extractor.AvcConfig
import androidx.media3.extractor.CeaUtil
import androidx.media3.extractor.Extractor
import androidx.media3.extractor.ExtractorInput
import androidx.media3.extractor.ExtractorOutput
import androidx.media3.extractor.HevcConfig
import androidx.media3.extractor.PositionHolder
import androidx.media3.extractor.SeekMap
import androidx.media3.extractor.SeekPoint
import androidx.media3.extractor.TrackOutput
import io.gotvh.tv.htsp.HtspException
import io.gotvh.tv.htsp.HtspMessage
import io.gotvh.tv.htsp.HtspSubscription
import java.io.IOException
import java.io.InterruptedIOException

/*
 * Playing an HTSP subscription with Media3, the way Kiall Mac Innes's android-tvheadend does it
 * (Apache 2.0): a DataSource hands the subscription's messages to an Extractor as a byte stream
 * ([4-byte length][HTSP message] …), and the Extractor turns "subscriptionStart" into tracks and
 * each "muxpkt" into a sample. Seeking is done by Tvheadend: the seek map says "time T is at
 * position T", so a seek reopens the DataSource at position T, which asks Tvheadend to skip there.
 */

/** Reads one subscription. The first open subscribes; later opens (seeks) skip in the timeshift buffer. */
@UnstableApi
class HtspDataSource(private val subscription: HtspSubscription) : BaseDataSource(/* isNetwork= */ true) {
    private var uri: Uri? = null
    private var opened = false
    private var current: ByteArray? = null
    private var pos = 0

    override fun open(dataSpec: DataSpec): Long {
        uri = dataSpec.uri
        transferInitializing(dataSpec)
        if (!subscription.subscribed) {
            subscription.subscribe()
            if (dataSpec.position > 0) subscription.skipTo(dataSpec.position)
        } else {
            subscription.skipTo(dataSpec.position)
        }
        current = null
        pos = 0
        opened = true
        transferStarted(dataSpec)
        return C.LENGTH_UNSET.toLong()
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        if (length == 0) return 0
        while (current == null || pos >= current!!.size) {
            if (!opened) return C.RESULT_END_OF_INPUT
            val body = subscription.take(250)
            if (body == null) {
                if (Thread.interrupted()) throw InterruptedIOException()
                if (subscription.ended) {
                    val reason = subscription.stopReason
                    if (reason != null && reason != "Stopped") throw HtspException(reason)
                    return C.RESULT_END_OF_INPUT
                }
                continue
            }
            // Frame it: 4-byte length, then the message.
            current = ByteArray(body.size + 4).also {
                it[0] = (body.size ushr 24).toByte()
                it[1] = (body.size ushr 16).toByte()
                it[2] = (body.size ushr 8).toByte()
                it[3] = body.size.toByte()
                System.arraycopy(body, 0, it, 4, body.size)
            }
            pos = 0
        }
        val chunk = current!!
        val n = minOf(length, chunk.size - pos)
        System.arraycopy(chunk, pos, buffer, offset, n)
        pos += n
        bytesTransferred(n)
        return n
    }

    override fun getUri(): Uri? = uri

    override fun close() {
        if (opened) {
            opened = false
            transferEnded()
        }
        uri = null
    }
}

/** Turns the framed HTSP messages into Media3 tracks and samples. */
@UnstableApi
class HtspExtractor : Extractor {
    private lateinit var output: ExtractorOutput
    private val tracks = HashMap<Int, Track>()
    private var tracksEnded = false
    private val header = ByteArray(4)
    private var body = ByteArray(256 * 1024)

    private class Track(val output: TrackOutput, val isVideo: Boolean, val isAac: Boolean, val codec: String) {
        /** AAC: the format waits for the first frame, whose own header says how to decode it. */
        var pendingFormat: Format? = null
    }

    /** Closed captions (CEA-608, carried inside the video frames). One track, chosen or not by the player. */
    private var captions: Array<TrackOutput> = emptyArray()

    override fun sniff(input: ExtractorInput): Boolean = true

    override fun init(output: ExtractorOutput) {
        this.output = output
        output.seekMap(object : SeekMap {
            override fun isSeekable() = true
            override fun getDurationUs() = C.TIME_UNSET
            override fun getSeekPoints(timeUs: Long) = SeekMap.SeekPoints(SeekPoint(timeUs, timeUs))
        })
    }

    override fun read(input: ExtractorInput, seekPosition: PositionHolder): Int {
        if (!input.readFully(header, 0, 4, /* allowEndOfInput= */ true)) return Extractor.RESULT_END_OF_INPUT
        val length = HtspMessage.readInt32(header, 0)
        if (length < 0 || length > 64 * 1024 * 1024) throw IOException("Bad HTSP frame")
        if (body.size < length) body = ByteArray(length)
        input.readFully(body, 0, length)
        val msg = HtspMessage.decode(body, 0, length)
        when (msg.method) {
            "subscriptionStart" -> start(msg)
            "muxpkt" -> packet(msg)
        }
        return Extractor.RESULT_CONTINUE
    }

    private fun start(msg: HtspMessage) {
        if (tracksEnded) return // tracks can't change after they're declared
        for (stream in msg.messages("streams")) {
            val index = stream.int("index") ?: continue
            val type = stream.string("type") ?: continue
            val format = formatFor(index, type, stream) ?: continue
            val isVideo = MimeTypes.isVideo(format.sampleMimeType)
            val out = output.track(index, if (isVideo) C.TRACK_TYPE_VIDEO else C.TRACK_TYPE_AUDIO)
            val track = Track(out, isVideo, type == "AAC", type)
            // AAC (always the case for converted streams away from home): Tvheadend's description can
            // disagree with what its converter sends (e.g. 5.1 described, stereo sent), which garbles
            // the sound. Each ADTS frame says what it really is, so take the format from the first one.
            // (adtsFormat is kept for later: overriding with the frame's own header made this phone's
            // decoder refuse the converted sound outright, so for now the format is Tvheadend's.)
            out.format(format)
            tracks[index] = track
        }
        if (tracks.values.any { it.isVideo }) {
            // ATSC / cable captions ride in the video (H.264/HEVC SEI, MPEG-2 user data): offer them as a text track.
            val cc = output.track(CAPTION_TRACK_ID, C.TRACK_TYPE_TEXT)
            cc.format(Format.Builder().setId("cc").setSampleMimeType(MimeTypes.APPLICATION_CEA608).setAccessibilityChannel(1).build())
            captions = arrayOf(CaptionReorder(cc))
        }
        output.endTracks()
        tracksEnded = true
    }

    private fun packet(msg: HtspMessage) {
        val track = tracks[msg.int("stream") ?: return] ?: return
        var payload = msg.bytes("payload") ?: return
        val timeUs = msg.long("pts") ?: msg.long("dts") ?: return
        track.pendingFormat?.let { described ->
            track.output.format(adtsFormat(described, payload) ?: described)
            track.pendingFormat = null
        }
        if (track.isAac && payload.size > 9 && (payload[0].toInt() and 0xFF) == 0xFF) {
            // Tvheadend sends AAC with its ADTS header; the decoder wants the raw frame.
            val headerSize = if ((payload[1].toInt() and 0x01) == 0) 9 else 7
            payload = payload.copyOfRange(headerSize, payload.size)
        }
        // Video: only I-frames are keyframes ('I' = 73; no frame type = treat as one).
        val frameType = msg.int("frametype", -1)
        val flags = if (!track.isVideo || frameType == -1 || frameType == 73) C.BUFFER_FLAG_KEY_FRAME else 0
        if (track.isVideo && captions.isNotEmpty()) runCatching { Captions.scan(track.codec, payload, timeUs, captions) }
        track.output.sampleData(ParsableByteArray(payload), payload.size)
        track.output.sampleMetadata(timeUs, flags, payload.size, 0, null)
    }

    override fun seek(position: Long, timeUs: Long) {
        // Pieces of captions held for reordering belong to the old position.
        captions.forEach { (it as? CaptionReorder)?.clear() }
    }

    override fun release() {}

    companion object {
        private const val CAPTION_TRACK_ID = 9999

        /**
         * The AAC format as the ADTS header at the start of [frame] states it (profile, sample rate,
         * channels), on top of [described]; null when there's no ADTS header.
         */
        fun adtsFormat(described: Format, frame: ByteArray): Format? {
            if (frame.size < 7 || (frame[0].toInt() and 0xFF) != 0xFF || (frame[1].toInt() and 0xF0) != 0xF0) return null
            val b2 = frame[2].toInt() and 0xFF
            val b3 = frame[3].toInt() and 0xFF
            val objectType = ((b2 shr 6) and 0x3) + 1
            val rateIndex = (b2 shr 2) and 0xF
            val channelConfig = ((b2 and 0x1) shl 2) or ((b3 shr 6) and 0x3)
            val rate = RATES.getOrNull(rateIndex)?.takeIf { it > 0 } ?: return null
            val channels = when (channelConfig) { 0 -> return null; 7 -> 8; else -> channelConfig }
            return described.buildUpon()
                .setSampleRate(rate)
                .setChannelCount(channels)
                .setInitializationData(listOf(AacUtil.buildAudioSpecificConfig(objectType, rateIndex, channelConfig)))
                .build()
        }

        // Tvheadend's sample-rate index ("rate") → Hz.
        private val RATES = intArrayOf(96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350, 0, 0, 0)

        fun formatFor(index: Int, type: String, s: HtspMessage): Format? {
            val b = Format.Builder().setId(index.toString())
            val lang = s.string("language")?.takeIf { it.isNotBlank() }
            when (type) {
                "H264", "HEVC", "MPEG2VIDEO" -> {
                    val meta = s.bytes("meta")
                    val init: List<ByteArray>? = meta?.let {
                        runCatching {
                            if (type == "H264") AvcConfig.parse(ParsableByteArray(it)).initializationData
                            else if (type == "HEVC") HevcConfig.parse(ParsableByteArray(it)).initializationData
                            else null
                        }.getOrNull()
                    }
                    b.setSampleMimeType(
                        when (type) {
                            "H264" -> MimeTypes.VIDEO_H264
                            "HEVC" -> MimeTypes.VIDEO_H265
                            else -> MimeTypes.VIDEO_MPEG2
                        },
                    )
                    s.int("width")?.let { b.setWidth(it) }
                    s.int("height")?.let { b.setHeight(it) }
                    s.int("duration")?.takeIf { it > 0 }?.let { b.setFrameRate(1_000_000f / it) }
                    if (!init.isNullOrEmpty()) b.setInitializationData(init)
                }
                "AAC", "AC3", "EAC3", "MPEG2AUDIO" -> {
                    val rate = s.int("rate")?.let { RATES[it and 0xF] }?.takeIf { it > 0 }
                    val channels = s.int("channels")
                    b.setSampleMimeType(
                        when (type) {
                            "AAC" -> MimeTypes.AUDIO_AAC
                            "AC3" -> MimeTypes.AUDIO_AC3
                            "EAC3" -> MimeTypes.AUDIO_E_AC3
                            else -> if (s.int("audio_version", 2) == 3) MimeTypes.AUDIO_MPEG else MimeTypes.AUDIO_MPEG_L2
                        },
                    )
                    rate?.let { b.setSampleRate(it) }
                    channels?.let { b.setChannelCount(it) }
                    lang?.let { b.setLanguage(it) }
                    b.setSelectionFlags(C.SELECTION_FLAG_AUTOSELECT)
                    if (type == "AAC") {
                        val config = s.bytes("meta") ?: if (rate != null && channels != null) AacUtil.buildAacLcAudioSpecificConfig(rate, channels) else null
                        config?.let { b.setInitializationData(listOf(it)) }
                    }
                }
                else -> return null // subtitles, teletext: not shown yet
            }
            return b.build()
        }
    }
}

/**
 * Finds closed-caption data in one video frame (Annex B) and hands it to Media3's CEA-608 output,
 * the same way its TS extractor does: H.264 SEI (NAL 6), HEVC prefix SEI (NAL 39), MPEG-2 user
 * data (start code 0xB2, "GA94").
 */
@UnstableApi
internal object Captions {
    fun scan(codec: String, data: ByteArray, timeUs: Long, outputs: Array<TrackOutput>) {
        var i = nextStart(data, 0)
        while (i >= 0) {
            val payload = i + 3 // first byte after 00 00 01
            val next = nextStart(data, payload)
            val end = if (next < 0) data.size else next
            if (payload < end) {
                val b = data[payload].toInt() and 0xFF
                when (codec) {
                    "H264" -> if (b and 0x1F == 6) sei(data, payload, end, 1, timeUs, outputs)
                    "HEVC" -> if ((b shr 1) and 0x3F == 39) sei(data, payload, end, 2, timeUs, outputs)
                    "MPEG2VIDEO" -> if (b == 0xB2) {
                        // From the start code, as UserDataReader expects: 00 00 01 B2 'GA94' 03 cc_data…
                        val buf = ParsableByteArray(data.copyOfRange(i, end))
                        if (buf.bytesLeft() >= 9 && buf.readInt() == 0x1B2 &&
                            buf.readInt() == CeaUtil.USER_DATA_IDENTIFIER_GA94 &&
                            buf.readUnsignedByte() == CeaUtil.USER_DATA_TYPE_CODE_MPEG_CC
                        ) CeaUtil.consumeCcData(timeUs, buf, outputs)
                    }
                }
            }
            i = next
        }
    }

    private fun sei(data: ByteArray, start: Int, end: Int, headerBytes: Int, timeUs: Long, outputs: Array<TrackOutput>) {
        // Drop emulation-prevention bytes (00 00 03 → 00 00).
        val nal = ByteArray(end - start)
        var n = 0
        var zeros = 0
        for (k in start until end) {
            val v = data[k].toInt() and 0xFF
            if (zeros >= 2 && v == 3) { zeros = 0; continue }
            zeros = if (v == 0) zeros + 1 else 0
            nal[n++] = data[k]
        }
        val buf = ParsableByteArray(nal, n)
        buf.setPosition(headerBytes)
        CeaUtil.consume(timeUs, buf, outputs)
    }

    /** Index of the next 00 00 01 at or after [from], or -1. */
    private fun nextStart(d: ByteArray, from: Int): Int {
        var i = from
        while (i + 2 < d.size) {
            if (d[i].toInt() == 0 && d[i + 1].toInt() == 0 && d[i + 2].toInt() == 1) return i
            i++
        }
        return -1
    }
}

/**
 * Caption data travels with video frames in decode order, which with B-frames isn't display
 * order; the caption decoder needs them in display order or the text comes out garbled and
 * stuttering. This holds the last few pieces and passes them on sorted by time (as Media3's own
 * TS extractor does). [depth] covers the deepest reordering H.264/MPEG-2 broadcasts use.
 */
@UnstableApi
internal class CaptionReorder(private val out: TrackOutput, private val depth: Int = 16) : TrackOutput {
    private class Piece(val timeUs: Long, val data: ByteArray, val flags: Int)

    private val queue = java.util.PriorityQueue<Piece>(compareBy { it.timeUs })
    private var pending = java.io.ByteArrayOutputStream()

    override fun format(format: Format) = out.format(format)

    override fun sampleData(input: androidx.media3.common.DataReader, length: Int, allowEndOfInput: Boolean, sampleDataPart: Int): Int {
        val buf = ByteArray(length)
        val n = input.read(buf, 0, length)
        if (n > 0) pending.write(buf, 0, n)
        return n
    }

    override fun sampleData(data: ParsableByteArray, length: Int, sampleDataPart: Int) {
        val buf = ByteArray(length)
        data.readBytes(buf, 0, length)
        pending.write(buf, 0, length)
    }

    override fun sampleMetadata(timeUs: Long, flags: Int, size: Int, offset: Int, cryptoData: TrackOutput.CryptoData?) {
        val bytes = pending.toByteArray()
        pending = java.io.ByteArrayOutputStream()
        queue.add(Piece(timeUs, bytes.copyOfRange(maxOf(0, bytes.size - size - offset), bytes.size - offset), flags))
        while (queue.size > depth) emit(queue.poll()!!)
    }

    private fun emit(p: Piece) {
        out.sampleData(ParsableByteArray(p.data), p.data.size)
        out.sampleMetadata(p.timeUs, p.flags, p.data.size, 0, null)
    }

    fun clear() {
        queue.clear()
        pending = java.io.ByteArrayOutputStream()
    }
}
