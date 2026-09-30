package io.gotvh.tv.ui

import android.view.KeyEvent
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.gotvh.tv.AppViewModel
import io.gotvh.tv.data.Recording

private enum class Col { Tabs, Left, Right }

/**
 * Recordings. "Recorded" is grouped by show (left) with its episodes (right); "Upcoming" is one list.
 *  Up/Down move · Left/Right between tabs, shows and episodes · OK play / choose · Menu · Back.
 */
@Composable
fun RecordingsScreen(vm: AppViewModel) {
    val context = LocalContext.current
    val focus = remember { FocusRequester() }
    var tab by remember { mutableIntStateOf(0) }
    var col by remember { mutableStateOf(Col.Left) }
    var left by remember { mutableIntStateOf(0) }
    var right by remember { mutableIntStateOf(0) }
    var action by remember { mutableStateOf<Recording?>(null) }
    var confirmDelete by remember { mutableStateOf<Recording?>(null) }

    val shows: List<Pair<String, List<Recording>>> = remember(vm.recorded) {
        vm.recorded.groupBy { it.title }
            .map { (title, list) -> title to list.sortedByDescending { it.start } }
            .sortedByDescending { (_, list) -> list.first().start }
    }
    val leftCount = if (tab == 0) shows.size else vm.upcoming.size
    val episodes = if (tab == 0) shows.getOrNull(left)?.second.orEmpty() else emptyList()
    val dialogOpen = action != null || confirmDelete != null

    LaunchedEffect(Unit) { focus.requestFocus() }
    LaunchedEffect(dialogOpen, vm.menuOpen) { if (!dialogOpen && !vm.menuOpen) focus.requestFocus() }
    LaunchedEffect(leftCount) { left = left.coerceIn(0, (leftCount - 1).coerceAtLeast(0)) }
    LaunchedEffect(episodes.size) { right = right.coerceIn(0, (episodes.size - 1).coerceAtLeast(0)) }

    BackHandler(enabled = !dialogOpen) { if (col == Col.Right) col = Col.Left else vm.goLive() }

    Box(
        Modifier
            .fillMaxSize()
            .background(Tv.bg)
            .focusRequester(focus)
            .focusable()
            .onPreviewKeyEvent { ev ->
                if (isHeldOk(ev)) return@onPreviewKeyEvent true
                if (dialogOpen || ev.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                val ok = ev.nativeKeyEvent.keyCode in setOf(KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER)
                when (val k = ev.nativeKeyEvent.keyCode) {
                    KeyEvent.KEYCODE_MENU -> vm.menuOpen = true
                    else -> when (col) {
                        Col.Tabs -> when (k) {
                            KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT -> { tab = 1 - tab; left = 0; right = 0 }
                            KeyEvent.KEYCODE_DPAD_DOWN -> if (leftCount > 0) col = Col.Left
                            else -> if (!ok) return@onPreviewKeyEvent false
                        }
                        Col.Left -> when {
                            k == KeyEvent.KEYCODE_DPAD_UP -> if (left == 0) col = Col.Tabs else left--
                            k == KeyEvent.KEYCODE_DPAD_DOWN -> left = (left + 1).coerceAtMost((leftCount - 1).coerceAtLeast(0))
                            k == KeyEvent.KEYCODE_DPAD_RIGHT && tab == 0 && episodes.isNotEmpty() -> { col = Col.Right; right = 0 }
                            ok && tab == 0 && episodes.isNotEmpty() -> if (episodes.size == 1) action = episodes[0] else { col = Col.Right; right = 0 }
                            ok && tab == 1 -> action = vm.upcoming.getOrNull(left)
                            else -> return@onPreviewKeyEvent false
                        }
                        Col.Right -> when {
                            k == KeyEvent.KEYCODE_DPAD_UP -> right = (right - 1).coerceAtLeast(0)
                            k == KeyEvent.KEYCODE_DPAD_DOWN -> right = (right + 1).coerceAtMost(episodes.size - 1)
                            k == KeyEvent.KEYCODE_DPAD_LEFT -> col = Col.Left
                            ok || k == KeyEvent.KEYCODE_MEDIA_PLAY || k == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE ->
                                episodes.getOrNull(right)?.let { action = it }
                            else -> return@onPreviewKeyEvent false
                        }
                    }
                }
                true
            },
    ) {
        Column(Modifier.fillMaxSize().padding(horizontal = 40.dp, vertical = 28.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                Text("Recordings", color = Tv.text, fontSize = 28.sp, fontWeight = FontWeight.Bold)
                Spacer(Modifier.width(12.dp))
                listOf("Recorded (${vm.recorded.size})", "Upcoming (${vm.upcoming.size})").forEachIndexed { i, label ->
                    val active = i == tab
                    val focused = active && col == Col.Tabs
                    Text(
                        label, fontSize = 18.sp,
                        color = if (focused) Color.Black else if (active) Tv.accent else Tv.muted,
                        fontWeight = if (active) FontWeight.Bold else FontWeight.Normal,
                        modifier = Modifier.background(if (focused) Tv.accent else Color.Transparent, RoundedCornerShape(16.dp))
                            .padding(horizontal = 14.dp, vertical = 6.dp),
                    )
                }
                Spacer(Modifier.weight(1f))
                Text("OK play · Back TV", color = Tv.muted, fontSize = 13.sp)
            }
            Spacer(Modifier.height(18.dp))
            if (leftCount == 0) {
                Text(if (tab == 0) "No recordings yet. Record from the guide (OK on a programme)." else "Nothing scheduled.",
                    color = Tv.muted, fontSize = 18.sp)
            } else if (tab == 0) {
                Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                    SelectList(Modifier.width(420.dp).fillMaxHeight(), shows.size, left, col == Col.Left) { i, sel ->
                        val (title, list) = shows[i]
                        Column {
                            Text(title, color = if (sel) Color.Black else Tv.text, fontSize = 18.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(if (list.size == 1) dayLabel(list[0].start) else "${list.size} recordings · latest ${dayLabel(list[0].start)}",
                                color = if (sel) Color(0xAA000000) else Tv.muted, fontSize = 14.sp)
                        }
                    }
                    SelectList(Modifier.weight(1f).fillMaxHeight(), episodes.size, right, col == Col.Right) { i, sel ->
                        val r = episodes[i]
                        val resume = vm.settings.resumePosition(r.uuid)
                        Column {
                            Text(r.subtitle.ifBlank { r.title }, color = if (sel) Color.Black else Tv.text, fontSize = 18.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(
                                "${dayLabel(r.start)} ${timeOf(context, r.start)} · ${r.durationSec / 60} min · ${r.channelName}" +
                                    if (r.isRecordingNow) " · ● recording" else "",
                                color = if (sel) Color(0xAA000000) else Tv.muted, fontSize = 14.sp, maxLines = 1,
                            )
                            if (resume > 0 && r.durationSec > 0) {
                                val f = (resume / 1000f / r.durationSec).coerceIn(0f, 1f)
                                Box(Modifier.padding(top = 4.dp).width(220.dp).height(4.dp).background(Color(0x33FFFFFF), RoundedCornerShape(2.dp))) {
                                    Box(Modifier.fillMaxHeight().fillMaxWidth(f).background(if (sel) Color.Black else Tv.accent, RoundedCornerShape(2.dp)))
                                }
                            }
                            if (sel && r.description.isNotBlank()) {
                                Text(r.description, color = Color(0xCC000000), fontSize = 14.sp, maxLines = 3, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 4.dp))
                            }
                        }
                    }
                }
            } else {
                SelectList(Modifier.fillMaxSize(), vm.upcoming.size, left, col == Col.Left) { i, sel ->
                    val r = vm.upcoming[i]
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        if (r.isRecordingNow) Box(Modifier.size(10.dp).background(Tv.rec, CircleShape))
                        Column {
                            Text(r.title + if (r.subtitle.isNotBlank()) " · ${r.subtitle}" else "", color = if (sel) Color.Black else Tv.text, fontSize = 18.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text("${dayLabel(r.start)} ${timeRange(context, r.start, r.stop)} · ${r.channelName}", color = if (sel) Color(0xAA000000) else Tv.muted, fontSize = 14.sp)
                        }
                    }
                }
            }
        }

        action?.let { r ->
            val finished = vm.recorded.any { it.uuid == r.uuid }
            val resume = vm.settings.resumePosition(r.uuid)
            val lines = listOf("${dayLabel(r.start)} ${timeRange(context, r.start, r.stop)} · ${r.channelName}", r.subtitle, r.description)
            val actions = buildList<Pair<String, () -> Unit>> {
                if (finished) {
                    if (resume > 0) add("Resume from ${clock(resume)}" to { action = null; vm.playRecording(r, fromStart = false) })
                    add((if (resume > 0) "Play from start" else "Play") to { action = null; vm.playRecording(r, fromStart = true) })
                    add("Delete" to { action = null; confirmDelete = r })
                } else {
                    add((if (r.isRecordingNow) "Stop recording" else "Don’t record") to { action = null; vm.cancelUpcoming(r) })
                }
                add("Close" to { action = null })
            }
            ActionDialog(r.title, lines, actions, onClose = { action = null })
        }
        confirmDelete?.let { r ->
            ActionDialog(
                "Delete “${r.title}”?",
                listOf("The recording and its file are removed from Tvheadend. This can’t be undone."),
                listOf("Cancel" to { confirmDelete = null }, "Delete" to { confirmDelete = null; vm.deleteRecording(r) }),
                onClose = { confirmDelete = null },
            )
        }
    }
}

/** A list with one highlighted row that follows the selection. */
@Composable
fun SelectList(
    modifier: Modifier,
    count: Int,
    selected: Int,
    active: Boolean,
    row: @Composable (index: Int, selected: Boolean) -> Unit,
) {
    val state = rememberLazyListState()
    LaunchedEffect(selected) { if (count > 0) state.animateScrollToItem((selected - 3).coerceAtLeast(0)) }
    LazyColumn(modifier, state = state, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        itemsIndexed(List(count) { it }) { i, _ ->
            val sel = i == selected && active
            Box(
                Modifier.fillMaxWidth()
                    .background(
                        when {
                            sel -> Tv.accent
                            i == selected -> Color(0x33F5B63F)
                            else -> Tv.cell
                        },
                        RoundedCornerShape(10.dp),
                    )
                    .padding(horizontal = 16.dp, vertical = 10.dp),
            ) { row(i, sel) }
        }
    }
}
