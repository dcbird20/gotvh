package io.gotvh.tv.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.gotvh.tv.AppViewModel
import io.gotvh.tv.data.Genre
import io.gotvh.tv.data.Program
import io.gotvh.tv.data.Recording
import io.gotvh.tv.nowSec

/*
 * One details card for everything you can pick: a programme (guide, search, the mini guide, the
 * player's Info) or a recording (Recordings, search). The most likely action is first and has the
 * highlight, so OK, OK does the obvious thing; Back or Close leaves.
 */

/** The card itself: title, details, description, a row of buttons (the first highlighted). */
@Composable
fun DetailsCard(
    title: String,
    subtitle: String,
    meta: String,
    status: String?,
    description: String,
    actions: List<Pair<String, () -> Unit>>,
    onClose: () -> Unit,
) {
    val first = remember { FocusRequester() }
    LaunchedEffect(title, actions.size) { runCatching { first.requestFocus() } }
    BackHandler { onClose() }
    Box(Modifier.fillMaxSize().background(Color(0xAA000000)), contentAlignment = Alignment.Center) {
        Column(
            Modifier.width(900.dp).background(Tv.panelSolid, RoundedCornerShape(14.dp)).padding(30.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(title, color = Tv.text, fontSize = 28.sp, fontWeight = FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (subtitle.isNotBlank()) Text(subtitle, color = Tv.muted, fontSize = 18.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (meta.isNotBlank()) Text(meta, color = Tv.muted, fontSize = 16.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            status?.let { Text(it, color = if (it.startsWith("●")) Tv.rec else Tv.accent, fontSize = 16.sp) }
            if (description.isNotBlank()) Text(description, color = Tv.text, fontSize = 17.sp, maxLines = 8, overflow = TextOverflow.Ellipsis)
            Spacer(Modifier.height(6.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                actions.forEachIndexed { i, (label, action) ->
                    TvButton(label, if (i == 0) Modifier.focusRequester(first) else Modifier) { action() }
                }
            }
        }
    }
}

/**
 * A programme. [onWatch] null = you're already watching it (the player's Info). Airing now: Watch
 * first; later: Record first. Empty guide time (a placeholder) can only be watched.
 */
@Composable
fun ProgramCard(vm: AppViewModel, p: Program, onClose: () -> Unit, onWatch: (() -> Unit)?) {
    val context = LocalContext.current
    val now = nowSec()
    val channel = vm.channels.firstOrNull { it.uuid == p.channelUuid }
    val actions = buildList<Pair<String, () -> Unit>> {
        if (onWatch != null && (p.isAiring(now) || p.placeholder)) add("Watch" to { onClose(); onWatch() })
        if (!p.placeholder) {
            if (p.isScheduled) {
                add((if (p.isRecordingNow) "Stop recording" else "Don’t record") to { vm.cancelRecording(p); onClose() })
            } else if (p.stop > now) {
                add("Record" to { vm.record(p); onClose() })
                if (p.seriesLink.isNotBlank()) add("Record series" to { vm.record(p, series = true); onClose() })
            }
        }
        if (onWatch != null && !p.isAiring(now) && !p.placeholder) add("Watch channel" to { onClose(); onWatch() })
        add("Close" to onClose)
    }
    DetailsCard(
        title = if (p.placeholder) (channel?.name ?: p.title) else p.title,
        subtitle = p.subtitle,
        meta = listOfNotNull("${dayLabel(p.start)} ${timeRange(context, p.start, p.stop)}", channel?.label, Genre.of(p)?.label).joinToString("  ·  "),
        status = when {
            p.isRecordingNow -> "● Recording now"
            p.isScheduled -> "● Will be recorded"
            else -> null
        },
        description = if (p.placeholder) "No guide information for this time." else p.description,
        actions = actions,
        onClose = onClose,
    )
}

/**
 * A recording: Resume (or Play) first, then From the start, Mark watched / unwatched, Delete (with
 * a confirmation) or Stop recording. Upcoming ones: Don't record (or, recording now, Watch from start).
 */
@Composable
fun RecordingCard(vm: AppViewModel, r: Recording, onClose: () -> Unit) {
    val context = LocalContext.current
    var confirmDelete by remember { mutableStateOf(false) }
    if (confirmDelete) {
        DetailsCard(
            title = "Delete “${r.title}”?",
            subtitle = r.subtitle,
            meta = "",
            status = null,
            description = "The recording and its file are removed from Tvheadend. This can’t be undone.",
            actions = listOf("Cancel" to { confirmDelete = false }, "Delete" to { vm.deleteRecording(r); onClose() }),
            onClose = { confirmDelete = false },
        )
        return
    }
    val finished = vm.recorded.any { it.uuid == r.uuid }
    val actions = buildList<Pair<String, () -> Unit>> {
        if (finished) {
            if (r.inProgress) {
                add("Resume from ${clock(vm.resumeMs(r))}" to { onClose(); vm.playRecording(r, fromStart = false) })
                add("From the start" to { onClose(); vm.playRecording(r, fromStart = true) })
            } else {
                add("Play" to { onClose(); vm.playRecording(r, fromStart = true) })
            }
            if (!r.isWatched) add("Mark watched" to { vm.markWatched(r, true); onClose() })
            else add("Mark unwatched" to { vm.markWatched(r, false); onClose() })
            if (r.isRecordingNow) add("Stop recording" to { vm.cancelUpcoming(r); onClose() })
            else add("Delete" to { confirmDelete = true })
        } else {
            if (r.isRecordingNow) add("Watch from start" to { onClose(); vm.playRecording(r, fromStart = true) })
            add((if (r.isRecordingNow) "Stop recording" else "Don’t record") to { vm.cancelUpcoming(r); onClose() })
        }
        add("Close" to onClose)
    }
    DetailsCard(
        title = r.title,
        subtitle = r.subtitle,
        meta = listOfNotNull("${dayLabel(r.start)} ${timeRange(context, r.start, r.stop)}", r.channelName.ifBlank { null }, "${r.durationSec / 60} min").joinToString("  ·  "),
        status = when {
            r.isRecordingNow -> "● Recording now"
            r.inProgress -> "In progress · ${r.minutesLeft} min left"
            r.isWatched -> "✓ Watched"
            else -> null
        },
        description = r.description,
        actions = actions,
        onClose = onClose,
    )
}

