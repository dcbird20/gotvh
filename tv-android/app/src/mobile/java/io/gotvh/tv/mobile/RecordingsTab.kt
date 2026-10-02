package io.gotvh.tv.mobile

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.gotvh.tv.AppViewModel
import io.gotvh.tv.data.Recording
import io.gotvh.tv.ui.Tv
import io.gotvh.tv.ui.clock
import io.gotvh.tv.ui.dayLabel
import io.gotvh.tv.ui.timeOf
import io.gotvh.tv.ui.timeRange

private data class Group(val key: String, val title: String, val items: List<Recording>, val isContinue: Boolean = false)

/**
 * Recordings: "Continue watching" first, then shows (newest first, unfinished ones on top); tap a
 * show for its recordings, tap a recording to play it (resuming where you stopped, on any device).
 * ⋮ on a recording: play from the start, mark watched / unwatched, delete or stop recording.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RecordingsTab(vm: AppViewModel) {
    var tab by rememberSaveable { mutableIntStateOf(0) }
    var openKey by rememberSaveable { mutableStateOf<String?>(null) }
    var confirmDelete by remember { mutableStateOf<Recording?>(null) }

    val groups = remember(vm.recorded) {
        val unfinished = vm.recorded.filter { it.inProgress }.sortedByDescending { it.start }
        val shows = vm.recorded.groupBy { it.title }
            .map { (title, list) -> Group(title, title, list.sortedByDescending { it.start }) }
            .sortedWith(compareByDescending<Group> { g -> g.items.any { !it.isWatched } }.thenByDescending { it.items.first().start })
        (if (unfinished.isEmpty()) emptyList() else listOf(Group("\u0000continue", "Continue watching", unfinished, isContinue = true))) + shows
    }
    val open = groups.firstOrNull { it.key == openKey }
    BackHandler(enabled = open != null) { openKey = null }

    Column(Modifier.fillMaxSize()) {
        if (open == null) {
            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp)) {
                listOf("Recorded (${vm.recorded.size})", "Upcoming (${vm.upcoming.size})").forEachIndexed { i, label ->
                    SegmentedButton(selected = tab == i, onClick = { tab = i }, shape = SegmentedButtonDefaults.itemShape(i, 2)) { Text(label) }
                }
            }
        } else {
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = { openKey = null }) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back to shows") }
                Text(open.title, color = Tv.text, fontSize = 18.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        when {
            open != null -> LazyColumn(Modifier.fillMaxSize()) {
                items(open.items, key = { it.uuid }) { r ->
                    RecordingRow(vm, r, withShow = open.isContinue, onDelete = { confirmDelete = r })
                }
            }
            tab == 0 && groups.isEmpty() -> Empty("No recordings yet. Record from the Guide.")
            tab == 0 -> LazyColumn(Modifier.fillMaxSize()) {
                items(groups, key = { it.key }) { g ->
                    if (!g.isContinue && g.items.size == 1) RecordingRow(vm, g.items[0], withShow = true, onDelete = { confirmDelete = g.items[0] })
                    else GroupRow(g) { openKey = g.key }
                }
            }
            vm.upcoming.isEmpty() -> Empty("Nothing scheduled.")
            else -> LazyColumn(Modifier.fillMaxSize()) {
                items(vm.upcoming, key = { it.uuid }) { r -> UpcomingRow(vm, r) }
            }
        }
    }

    confirmDelete?.let { r ->
        AlertDialog(
            onDismissRequest = { confirmDelete = null },
            title = { Text("Delete “${r.title}”?") },
            text = { Text("The recording and its file are removed from Tvheadend. This can’t be undone.") },
            confirmButton = { TextButton(onClick = { confirmDelete = null; vm.deleteRecording(r) }) { Text("Delete", color = Tv.rec) } },
            dismissButton = { TextButton(onClick = { confirmDelete = null }) { Text("Cancel") } },
            containerColor = Tv.panelSolid,
        )
    }
}

@Composable
private fun Empty(text: String) {
    Box(Modifier.fillMaxSize().padding(32.dp), contentAlignment = Alignment.TopCenter) { Text(text, color = Tv.muted, fontSize = 15.sp) }
}

@Composable
private fun GroupRow(g: Group, onOpen: () -> Unit) {
    val fresh = g.items.count { it.isNew }
    val progress = g.items.count { it.inProgress }
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onOpen).padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Marker(newDot = fresh > 0 && !g.isContinue, watched = g.items.all { it.isWatched }, cont = g.isContinue)
        Column(Modifier.weight(1f)) {
            Text(g.title, color = if (g.isContinue) Tv.accent else Tv.text, fontSize = 16.sp, fontWeight = if (g.isContinue) FontWeight.SemiBold else FontWeight.Normal,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                listOfNotNull(
                    "${g.items.size} recording${if (g.items.size == 1) "" else "s"}",
                    if (progress > 0 && !g.isContinue) "$progress in progress" else null,
                    if (fresh > 0) "$fresh new" else null,
                    if (!g.isContinue) "latest ${dayLabel(g.items.first().start)}" else null,
                ).joinToString(" · "),
                color = Tv.muted, fontSize = 13.sp,
            )
        }
        Text("›", color = Tv.muted, fontSize = 22.sp)
    }
}

/** Dot = new, ✓ = watched (dimmed), nothing = in progress (it has a bar). */
@Composable
private fun Marker(newDot: Boolean, watched: Boolean, cont: Boolean = false) {
    Box(Modifier.width(18.dp), contentAlignment = Alignment.Center) {
        when {
            cont -> Text("▶", color = Tv.accent, fontSize = 13.sp)
            newDot -> Box(Modifier.size(9.dp).background(Tv.accent, CircleShape))
            watched -> Text("✓", color = Tv.muted, fontSize = 14.sp)
        }
    }
}

@Composable
private fun RecordingRow(vm: AppViewModel, r: Recording, withShow: Boolean, onDelete: () -> Unit) {
    val context = LocalContext.current
    var menu by remember { mutableStateOf(false) }
    Row(
        Modifier.fillMaxWidth().clickable { vm.playRecording(r, fromStart = !r.inProgress) }.padding(start = 16.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Marker(newDot = r.isNew, watched = r.isWatched)
        Column(Modifier.weight(1f)) {
            val name = when {
                withShow && r.subtitle.isNotBlank() -> "${r.title} · ${r.subtitle}"
                withShow -> r.title
                else -> r.subtitle.ifBlank { r.title }
            }
            Text(name, color = if (r.isWatched) Tv.muted else Tv.text, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                listOfNotNull(
                    "${dayLabel(r.start)} ${timeOf(context, r.start)}", "${r.durationSec / 60} min", r.channelName.ifBlank { null },
                    if (r.inProgress) "${r.minutesLeft} min left" else null,
                    if (r.isRecordingNow) "● recording" else null,
                ).joinToString(" · "),
                color = Tv.muted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            if (r.inProgress && r.durationSec > 0) {
                Box(Modifier.padding(top = 4.dp).width(180.dp).height(3.dp).background(Color(0x33FFFFFF), RoundedCornerShape(2.dp))) {
                    Box(Modifier.fillMaxHeight().fillMaxWidth((r.playPositionSec.toFloat() / r.durationSec).coerceIn(0f, 1f)).background(Tv.accent, RoundedCornerShape(2.dp)))
                }
            }
        }
        Box {
            IconButton(onClick = { menu = true }) { Icon(Icons.Filled.MoreVert, contentDescription = "More") }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                if (r.inProgress) {
                    DropdownMenuItem(text = { Text("Resume from ${clock(vm.resumeMs(r))}") }, onClick = { menu = false; vm.playRecording(r, fromStart = false) })
                }
                DropdownMenuItem(text = { Text(if (r.inProgress) "Play from the start" else "Play") }, onClick = { menu = false; vm.playRecording(r, fromStart = true) })
                if (!r.isWatched) DropdownMenuItem(text = { Text("Mark watched") }, onClick = { menu = false; vm.markWatched(r, true) })
                else DropdownMenuItem(text = { Text("Mark unwatched") }, onClick = { menu = false; vm.markWatched(r, false) })
                if (r.isRecordingNow) DropdownMenuItem(text = { Text("Stop recording") }, onClick = { menu = false; vm.cancelUpcoming(r) })
                else DropdownMenuItem(text = { Text("Delete", color = Tv.rec) }, onClick = { menu = false; onDelete() })
            }
        }
    }
}

@Composable
private fun UpcomingRow(vm: AppViewModel, r: Recording) {
    val context = LocalContext.current
    var menu by remember { mutableStateOf(false) }
    Row(
        Modifier.fillMaxWidth().clickable { menu = true }.padding(start = 16.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(Modifier.width(18.dp), contentAlignment = Alignment.Center) {
            if (r.isRecordingNow) Box(Modifier.size(9.dp).background(Tv.rec, CircleShape))
        }
        Column(Modifier.weight(1f)) {
            Text(r.title + if (r.subtitle.isNotBlank()) " · ${r.subtitle}" else "", color = Tv.text, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("${dayLabel(r.start)} ${timeRange(context, r.start, r.stop)} · ${r.channelName}", color = Tv.muted, fontSize = 12.sp, maxLines = 1)
        }
        Box {
            IconButton(onClick = { menu = true }) { Icon(Icons.Filled.MoreVert, contentDescription = "More") }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                if (r.isRecordingNow) DropdownMenuItem(text = { Text("Watch from the start") }, onClick = { menu = false; vm.playRecording(r, fromStart = true) })
                DropdownMenuItem(text = { Text(if (r.isRecordingNow) "Stop recording" else "Don’t record") }, onClick = { menu = false; vm.cancelUpcoming(r) })
            }
        }
    }
}
