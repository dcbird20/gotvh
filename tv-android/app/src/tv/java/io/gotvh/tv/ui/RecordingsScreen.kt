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

private enum class Level { Tabs, Shows, Episodes }

/** A row on the first level: one show, or "Continue watching" (everything stopped partway). */
private data class Group(val key: String, val title: String, val items: List<Recording>, val isContinue: Boolean = false)

private const val CONTINUE = "\u0000continue"

/**
 * Recordings, full width. "Recorded" lists shows (Continue watching first, then shows with something
 * new or unfinished); OK on a show lists its recordings. Each recording is New (dot), In progress
 * (bar, time left) or Watched (✓, dimmed): kept in Tvheadend, so every TV and Kodi agree.
 *  Up/Down move · OK: a show's recordings, or a recording's card (Resume / Play first) · Left/Back up a level.
 */
@Composable
fun RecordingsScreen(vm: AppViewModel) {
    val context = LocalContext.current
    val focus = remember { FocusRequester() }
    var tab by remember { mutableIntStateOf(0) }
    var level by remember { mutableStateOf(Level.Shows) }
    var showIndex by remember { mutableIntStateOf(0) }
    var epIndex by remember { mutableIntStateOf(0) }
    var openKey by remember { mutableStateOf<String?>(null) }
    var upIndex by remember { mutableIntStateOf(0) }
    var action by remember { mutableStateOf<Recording?>(null) }
    var confirmDelete by remember { mutableStateOf<Recording?>(null) }

    val groups: List<Group> = remember(vm.recorded) {
        val unfinished = vm.recorded.filter { it.inProgress }.sortedByDescending { it.start }
        val shows = vm.recorded.groupBy { it.title }
            .map { (title, list) -> Group(title, title, list.sortedByDescending { it.start }) }
            .sortedWith(compareByDescending<Group> { g -> g.items.any { !it.isWatched } }.thenByDescending { it.items.first().start })
        (if (unfinished.isEmpty()) emptyList() else listOf(Group(CONTINUE, "Continue watching", unfinished, isContinue = true))) + shows
    }
    val open: Group? = groups.firstOrNull { it.key == openKey }
    val episodes = open?.items.orEmpty()
    val dialogOpen = action != null || confirmDelete != null

    LaunchedEffect(Unit) { focus.requestFocus() }
    // Recordings start and finish while this is open: keep the list current.
    LaunchedEffect(Unit) {
        while (true) {
            kotlinx.coroutines.delay(60_000)
            vm.loadRecordings()
        }
    }
    LaunchedEffect(dialogOpen, vm.menuOpen) { if (!dialogOpen && !vm.menuOpen) focus.requestFocus() }
    // The list changed (deleted, finished): keep the selection in range; an emptied show closes.
    LaunchedEffect(groups) {
        showIndex = showIndex.coerceIn(0, (groups.size - 1).coerceAtLeast(0))
        if (level == Level.Episodes && open == null) level = Level.Shows
        epIndex = epIndex.coerceIn(0, (episodes.size - 1).coerceAtLeast(0))
    }
    LaunchedEffect(vm.upcoming.size) { upIndex = upIndex.coerceIn(0, (vm.upcoming.size - 1).coerceAtLeast(0)) }

    fun play(r: Recording) = vm.playRecording(r, fromStart = !r.inProgress)
    fun openGroup(g: Group) { openKey = g.key; epIndex = 0; level = Level.Episodes }
    fun closeGroup() {
        level = Level.Shows
        groups.indexOfFirst { it.key == openKey }.takeIf { it >= 0 }?.let { showIndex = it }
    }

    BackHandler(enabled = !dialogOpen) { if (level == Level.Episodes) closeGroup() else vm.backToVideo() }

    Box(
        Modifier
            .fillMaxSize()
            // Translucent: what's playing stays visible (and playing) behind.
            .background(Color(0xE60B1220))
            .focusRequester(focus)
            .focusable()
            .onPreviewKeyEvent { ev ->
                if (isHeldOk(ev)) return@onPreviewKeyEvent true
                if (dialogOpen || ev.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                val k = ev.nativeKeyEvent.keyCode
                val ok = k in setOf(KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER,
                    KeyEvent.KEYCODE_MEDIA_PLAY, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE)
                if (k == KeyEvent.KEYCODE_MENU) { vm.menuOpen = true; return@onPreviewKeyEvent true }
                when (level) {
                    Level.Tabs -> when {
                        k == KeyEvent.KEYCODE_DPAD_LEFT || k == KeyEvent.KEYCODE_DPAD_RIGHT -> tab = 1 - tab
                        k == KeyEvent.KEYCODE_DPAD_DOWN -> level = Level.Shows
                        ok -> level = Level.Shows
                        else -> return@onPreviewKeyEvent false
                    }
                    Level.Shows -> if (tab == 1) when {
                        k == KeyEvent.KEYCODE_DPAD_UP -> if (upIndex == 0) level = Level.Tabs else upIndex--
                        k == KeyEvent.KEYCODE_DPAD_DOWN -> upIndex = (upIndex + 1).coerceAtMost((vm.upcoming.size - 1).coerceAtLeast(0))
                        ok || k == KeyEvent.KEYCODE_DPAD_RIGHT -> action = vm.upcoming.getOrNull(upIndex)
                        else -> return@onPreviewKeyEvent false
                    } else {
                        val g = groups.getOrNull(showIndex)
                        val single = g != null && !g.isContinue && g.items.size == 1
                        when {
                            k == KeyEvent.KEYCODE_DPAD_UP -> if (showIndex == 0) level = Level.Tabs else showIndex--
                            k == KeyEvent.KEYCODE_DPAD_DOWN -> showIndex = (showIndex + 1).coerceAtMost((groups.size - 1).coerceAtLeast(0))
                            g == null -> return@onPreviewKeyEvent false
                            ok -> if (single) action = g.items[0] else openGroup(g)
                            k == KeyEvent.KEYCODE_DPAD_RIGHT -> if (single) action = g.items[0] else openGroup(g)
                            else -> return@onPreviewKeyEvent false
                        }
                    }
                    Level.Episodes -> when {
                        k == KeyEvent.KEYCODE_DPAD_UP -> epIndex = (epIndex - 1).coerceAtLeast(0)
                        k == KeyEvent.KEYCODE_DPAD_DOWN -> epIndex = (epIndex + 1).coerceAtMost((episodes.size - 1).coerceAtLeast(0))
                        k == KeyEvent.KEYCODE_DPAD_LEFT -> closeGroup()
                        ok -> episodes.getOrNull(epIndex)?.let { action = it }
                        k == KeyEvent.KEYCODE_DPAD_RIGHT -> episodes.getOrNull(epIndex)?.let { action = it }
                        else -> return@onPreviewKeyEvent false
                    }
                }
                true
            },
    ) {
        Column(Modifier.fillMaxSize().padding(horizontal = 48.dp, vertical = 28.dp)) {
            // Header: tabs, or the open show's name.
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                Text("Recordings", color = Tv.text, fontSize = 28.sp, fontWeight = FontWeight.Bold)
                Spacer(Modifier.width(12.dp))
                if (level == Level.Episodes && open != null) {
                    Text("›  ${open.title}", color = Tv.accent, fontSize = 20.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                } else {
                    val newCount = vm.recorded.count { it.isNew }
                    listOf("Recorded (${vm.recorded.size}${if (newCount > 0) " · $newCount new" else ""})", "Upcoming (${vm.upcoming.size})")
                        .forEachIndexed { i, label ->
                            val active = i == tab
                            val focused = active && level == Level.Tabs
                            Text(
                                label, fontSize = 18.sp,
                                color = if (focused) Color.Black else if (active) Tv.accent else Tv.muted,
                                fontWeight = if (active) FontWeight.Bold else FontWeight.Normal,
                                modifier = Modifier.background(if (focused) Tv.accent else Color.Transparent, RoundedCornerShape(16.dp))
                                    .padding(horizontal = 14.dp, vertical = 6.dp),
                            )
                        }
                }
                Spacer(Modifier.weight(1f))
                Text(
                    when {
                        tab == 1 && level != Level.Episodes -> "OK options · Back TV"
                        level == Level.Episodes -> "OK details · ← shows"
                        else -> "OK open · Back TV"
                    },
                    color = Tv.muted, fontSize = 13.sp,
                )
            }
            Spacer(Modifier.height(14.dp))

            val selected: Recording? = when {
                tab == 1 && level != Level.Episodes -> vm.upcoming.getOrNull(upIndex)
                level == Level.Episodes -> episodes.getOrNull(epIndex)
                else -> groups.getOrNull(showIndex)?.takeIf { !it.isContinue && it.items.size == 1 }?.items?.first()
            }
            val selectedGroup = if (tab == 0 && level != Level.Episodes) groups.getOrNull(showIndex) else null

            if (tab == 0 && groups.isEmpty()) {
                Text("No recordings yet. Record from the guide (OK on a programme).", color = Tv.muted, fontSize = 18.sp)
            } else if (tab == 1 && vm.upcoming.isEmpty() && level != Level.Episodes) {
                Text("Nothing scheduled.", color = Tv.muted, fontSize = 18.sp)
            } else {
                Summary(selected, selectedGroup)
                Spacer(Modifier.height(12.dp))
                when {
                    level == Level.Episodes -> SelectList(Modifier.fillMaxSize(), episodes.size, epIndex, true) { i, sel ->
                        RecordingRow(episodes[i], sel, withShow = open?.isContinue == true)
                    }
                    tab == 0 -> SelectList(Modifier.fillMaxSize(), groups.size, showIndex, level == Level.Shows) { i, sel ->
                        GroupRow(groups[i], sel)
                    }
                    else -> SelectList(Modifier.fillMaxSize(), vm.upcoming.size, upIndex, level == Level.Shows) { i, sel ->
                        val r = vm.upcoming[i]
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            Box(Modifier.width(18.dp), contentAlignment = Alignment.Center) {
                                if (r.isRecordingNow) Box(Modifier.size(10.dp).background(Tv.rec, CircleShape))
                            }
                            Text(r.title + if (r.subtitle.isNotBlank()) " · ${r.subtitle}" else "", color = if (sel) Color.Black else Tv.text,
                                fontSize = 18.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                            Text("${dayLabel(r.start)} ${timeRange(context, r.start, r.stop)} · ${r.channelName}",
                                color = if (sel) Color(0xAA000000) else Tv.muted, fontSize = 15.sp, maxLines = 1)
                        }
                    }
                }
            }
        }

        action?.let { r -> RecordingCard(vm, r, onClose = { action = null }) }
    }
}

/** Details of what's selected, in a fixed space above the list (so the list never jumps). */
@Composable
private fun Summary(r: Recording?, group: Group?) {
    val context = LocalContext.current
    Column(Modifier.fillMaxWidth().height(96.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        when {
            r != null -> {
                Text(r.title + if (r.subtitle.isNotBlank()) " · ${r.subtitle}" else "", color = Tv.text, fontSize = 22.sp,
                    fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    listOfNotNull(
                        "${dayLabel(r.start)} ${timeRange(context, r.start, r.stop)}", r.channelName.ifBlank { null },
                        when {
                            r.isRecordingNow -> "● Recording now"
                            r.inProgress -> "In progress · ${r.minutesLeft} min left"
                            r.isWatched -> "✓ Watched"
                            r.stop < io.gotvh.tv.nowSec() -> "New"
                            else -> null
                        },
                    ).joinToString("  ·  "),
                    color = Tv.muted, fontSize = 15.sp, maxLines = 1,
                )
                if (r.description.isNotBlank()) Text(r.description, color = Tv.muted, fontSize = 15.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            group != null -> {
                Text(group.title, color = Tv.text, fontSize = 22.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(if (group.isContinue) "Recordings you stopped partway. OK to see them; OK on one resumes where you left off."
                    else groupLine(group) + " · OK to see them", color = Tv.muted, fontSize = 15.sp, maxLines = 2)
            }
        }
    }
}

private fun groupLine(g: Group): String {
    val progress = g.items.count { it.inProgress }
    val fresh = g.items.count { it.isNew }
    return listOfNotNull(
        if (g.items.size == 1) "1 recording" else "${g.items.size} recordings",
        if (progress > 0) "$progress in progress" else null,
        if (fresh > 0) "$fresh new" else null,
        if (!g.isContinue) "latest ${dayLabel(g.items.first().start)}" else null,
    ).joinToString(" · ")
}

/** Left margin marker: dot = new, ✓ = watched, nothing = in progress (it has a bar instead). */
@Composable
private fun Marker(newDot: Boolean, watched: Boolean, sel: Boolean) {
    Box(Modifier.width(22.dp), contentAlignment = Alignment.Center) {
        when {
            newDot -> Box(Modifier.size(10.dp).background(if (sel) Color.Black else Tv.accent, CircleShape))
            watched -> Text("✓", color = if (sel) Color(0x99000000) else Tv.muted, fontSize = 16.sp)
        }
    }
}

@Composable
private fun GroupRow(g: Group, sel: Boolean) {
    val context = LocalContext.current
    val allWatched = g.items.all { it.isWatched }
    val fg = when { sel -> Color.Black; allWatched -> Tv.muted; else -> Tv.text }
    val sub = if (sel) Color(0xAA000000) else Tv.muted
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        if (g.isContinue) {
            Box(Modifier.width(22.dp), contentAlignment = Alignment.Center) { Text("▶", color = if (sel) Color.Black else Tv.accent, fontSize = 15.sp) }
        } else {
            Marker(newDot = g.items.any { it.isNew }, watched = allWatched, sel = sel)
        }
        Text(g.title, color = if (g.isContinue && !sel) Tv.accent else fg, fontSize = 19.sp,
            fontWeight = if (g.isContinue) FontWeight.SemiBold else FontWeight.Normal,
            maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        val only = g.items.singleOrNull()?.takeIf { !g.isContinue }
        Text(
            if (only != null) recordingMeta(context, only) else groupLine(g),
            color = sub, fontSize = 15.sp, maxLines = 1,
        )
    }
}

@Composable
private fun RecordingRow(r: Recording, sel: Boolean, withShow: Boolean) {
    val context = LocalContext.current
    val fg = when { sel -> Color.Black; r.isWatched -> Tv.muted; else -> Tv.text }
    val sub = if (sel) Color(0xAA000000) else Tv.muted
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Marker(newDot = r.isNew, watched = r.isWatched, sel = sel)
        val name = when {
            withShow && r.subtitle.isNotBlank() -> "${r.title} · ${r.subtitle}"
            withShow -> r.title
            else -> r.subtitle.ifBlank { r.title }
        }
        Column(Modifier.weight(1f)) {
            Text(name, color = fg, fontSize = 19.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (r.inProgress && r.durationSec > 0) {
                val f = (r.playPositionSec.toFloat() / r.durationSec).coerceIn(0f, 1f)
                Box(Modifier.padding(top = 5.dp).width(260.dp).height(4.dp).background(if (sel) Color(0x33000000) else Color(0x33FFFFFF), RoundedCornerShape(2.dp))) {
                    Box(Modifier.fillMaxHeight().fillMaxWidth(f).background(if (sel) Color.Black else Tv.accent, RoundedCornerShape(2.dp)))
                }
            }
        }
        Text(recordingMeta(context, r), color = sub, fontSize = 15.sp, maxLines = 1)
    }
}

private fun recordingMeta(context: android.content.Context, r: Recording): String =
    listOfNotNull(
        "${dayLabel(r.start)} ${timeOf(context, r.start)}",
        "${r.durationSec / 60} min",
        r.channelName.ifBlank { null },
        if (r.inProgress) "${r.minutesLeft} min left" else null,
        if (r.isRecordingNow) "● recording" else null,
    ).joinToString(" · ")

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
