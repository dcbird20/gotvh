package io.gotvh.tv.data

import io.gotvh.tv.nowSec

/*
 * The Recordings filter, shared by the TV and phone apps (and the same idea as the admin's filter box):
 * it matches title, episode, channel and a status word; every typed word has to be found.
 */

/** Typed text → lower-case words. Empty = no filter. */
fun recordingFilterTerms(query: String): List<String> =
    query.trim().lowercase().split(Regex("\\s+")).filter { it.isNotEmpty() }

fun recordingMatches(r: Recording, terms: List<String>): Boolean {
    if (terms.isEmpty()) return true
    val status = when {
        r.isRecordingNow -> "recording"
        r.inProgress -> "in progress"
        r.isWatched -> "watched"
        r.stop < nowSec() -> "new"
        else -> "scheduled"
    }
    val text = "${r.title} ${r.subtitle} ${r.channelName} $status".lowercase()
    return terms.all { text.contains(it) }
}

/** "3" or, while filtering, "3 of 40". */
fun filterCount(shown: Int, total: Int): String = if (shown == total) "$shown" else "$shown of $total"
