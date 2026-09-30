package io.gotvh.tv.data

/** A channel as the TV app needs it. [number] is "" when the channel has none. */
data class Channel(
    val uuid: String,
    val name: String,
    val number: String,
    val icon: String?,
) {
    val label: String get() = if (number.isNotEmpty()) "$number  $name" else name
}

/** One guide entry. Times are Unix seconds, as Tvheadend sends them. */
data class Program(
    val eventId: Long,
    val channelUuid: String,
    val start: Long,
    val stop: Long,
    val title: String,
    val subtitle: String,
    val description: String,
    val genre: List<Int>,
    /** Tvheadend's DVR state for this event: "", "scheduled", "recording", "completed", … */
    val dvrState: String,
    val dvrUuid: String,
    val seriesLink: String,
) {
    fun isAiring(nowSec: Long) = start <= nowSec && stop > nowSec
    val isScheduled: Boolean get() = dvrUuid.isNotEmpty() && (dvrState.startsWith("scheduled") || dvrState.startsWith("recording"))
    val isRecordingNow: Boolean get() = dvrState.startsWith("recording")
}
