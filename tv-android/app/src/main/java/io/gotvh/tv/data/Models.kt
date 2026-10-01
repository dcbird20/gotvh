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
    /** Made up by the app for time with no guide information: one-hour blocks named after the channel. */
    val placeholder: Boolean = false,
) {
    fun isAiring(nowSec: Long) = start <= nowSec && stop > nowSec
    val isScheduled: Boolean get() = dvrUuid.isNotEmpty() && (dvrState.startsWith("scheduled") || dvrState.startsWith("recording"))
    val isRecordingNow: Boolean get() = dvrState.startsWith("recording")
}

/** A DVR entry: finished or upcoming. Times are Unix seconds. */
data class Recording(
    val uuid: String,
    val title: String,
    val subtitle: String,
    val description: String,
    val channelName: String,
    val start: Long,
    val stop: Long,
    val filesize: Long,
    /** Tvheadend's status text, e.g. "Completed OK", "Scheduled for recording". */
    val status: String,
    val schedStatus: String,
    /** Times played to the end, shared by every app using this Tvheadend (Kodi too). */
    val playCount: Int = 0,
    /** Where playback stopped, in seconds; 0 = not started or finished. */
    val playPositionSec: Long = 0,
) {
    val durationSec: Long get() = (stop - start).coerceAtLeast(0)
    val isRecordingNow: Boolean get() = schedStatus.startsWith("recording")
    val inProgress: Boolean get() = playPositionSec > 0
    val isWatched: Boolean get() = !inProgress && playCount > 0
    val isNew: Boolean get() = !inProgress && playCount == 0
    val minutesLeft: Long get() = ((durationSec - playPositionSec).coerceAtLeast(0) + 59) / 60
}

/** An auto-record rule (Tvheadend "dvr/autorec"). */
data class AutorecRule(
    val uuid: String,
    val name: String,
    val title: String,
    val channelUuid: String,
    val enabled: Boolean,
    val comment: String,
) {
    val label: String get() = name.ifBlank { title }.ifBlank { "(any programme)" }
}
