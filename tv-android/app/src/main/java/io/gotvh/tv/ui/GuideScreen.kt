package io.gotvh.tv.ui

import android.view.KeyEvent
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
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
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.coerceAtLeast
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.gotvh.tv.AppViewModel
import io.gotvh.tv.Screen
import io.gotvh.tv.data.Channel
import io.gotvh.tv.data.Genre
import io.gotvh.tv.data.Program
import io.gotvh.tv.nowSec
import kotlinx.coroutines.delay

/** Two hours across the screen, moving in half-hour steps. */
private const val WINDOW = 2 * 3600L
private const val STEP = 1800L
private const val PAGE = 7
private val CHANNEL_COL = 220.dp
private val ROW_HEIGHT = 60.dp

private fun alignDown(sec: Long) = sec - Math.floorMod(sec, STEP)

/**
 * The guide. Focus is one programme at a time ("virtual focus"): the grid keeps a channel row and a
 * point in time, so Up/Down stay at the same time of day, like a paper guide.
 *  Left/Right previous/next programme (the window scrolls at the edges) · Up/Down channel ·
 *  Ch+/Ch− a page of channels · ⏪/⏩ two hours · OK details · ▶ watch · Menu settings · Back TV.
 */
@Composable
fun GuideScreen(vm: AppViewModel) {
    val context = LocalContext.current
    val channels = vm.channels
    val focus = remember { FocusRequester() }
    val listState = rememberLazyListState()
    var row by remember { mutableIntStateOf(vm.guideRow.coerceIn(0, (channels.size - 1).coerceAtLeast(0))) }
    var now by remember { mutableLongStateOf(nowSec()) }
    val earliest = alignDown(now) - STEP
    var windowStart by remember { mutableLongStateOf(alignDown(nowSec())) }
    var anchor by remember { mutableLongStateOf(nowSec()) }
    var detail by remember { mutableStateOf<Program?>(null) }
    val windowEnd = windowStart + WINDOW

    val channel: Channel? = channels.getOrNull(row)
    val rowPrograms = channel?.let { vm.programsFor(it.uuid) }.orEmpty()
    val selected: Program? = rowPrograms.firstOrNull { it.start <= anchor && it.stop > anchor }
        ?: rowPrograms.firstOrNull { it.start > anchor && it.start < windowEnd }

    LaunchedEffect(Unit) {
        listState.scrollToItem((row - 2).coerceAtLeast(0))
        while (true) {
            delay(30_000)
            now = nowSec()
        }
    }
    LaunchedEffect(windowStart) { vm.ensureGuide(windowStart - 3600, windowStart + 6 * 3600) }
    LaunchedEffect(detail) { if (detail == null) focus.requestFocus() }
    LaunchedEffect(row) {
        val visible = listState.layoutInfo.visibleItemsInfo
        if (visible.isEmpty()) return@LaunchedEffect
        val first = visible.first().index
        val last = visible.last().index
        if (row <= first) listState.animateScrollToItem((row - 1).coerceAtLeast(0))
        else if (row >= last) listState.animateScrollToItem((row - (last - first) + 2).coerceAtLeast(0))
    }

    BackHandler(enabled = detail == null) { vm.screen = Screen.Watch }

    /** Point the grid at [t], scrolling the window so it's comfortably on screen. */
    fun moveTo(t: Long) {
        anchor = t.coerceAtLeast(earliest)
        while (anchor < windowStart && windowStart > earliest) windowStart -= STEP
        while (anchor > windowStart + WINDOW - 1200) windowStart += STEP
    }

    fun watch(index: Int) {
        if (index != vm.currentIndex) vm.tune(index)
        vm.screen = Screen.Watch
    }

    Box(
        Modifier
            .fillMaxSize()
            .background(Color(0xF20B1220))
            .focusRequester(focus)
            .focusable()
            .onPreviewKeyEvent { ev ->
                if (detail != null || ev.type != KeyEventType.KeyDown || channels.isEmpty()) return@onPreviewKeyEvent false
                when (ev.nativeKeyEvent.keyCode) {
                    KeyEvent.KEYCODE_DPAD_UP -> row = (row - 1).coerceAtLeast(0)
                    KeyEvent.KEYCODE_DPAD_DOWN -> row = (row + 1).coerceAtMost(channels.size - 1)
                    KeyEvent.KEYCODE_CHANNEL_UP, KeyEvent.KEYCODE_PAGE_UP -> row = (row - PAGE).coerceAtLeast(0)
                    KeyEvent.KEYCODE_CHANNEL_DOWN, KeyEvent.KEYCODE_PAGE_DOWN -> row = (row + PAGE).coerceAtMost(channels.size - 1)
                    KeyEvent.KEYCODE_DPAD_RIGHT -> {
                        val next = if (selected != null) rowPrograms.firstOrNull { it.start >= selected.stop - 1 }
                        else rowPrograms.firstOrNull { it.start > anchor }
                        moveTo(next?.start ?: (anchor + STEP))
                    }
                    KeyEvent.KEYCODE_DPAD_LEFT -> {
                        val prev = if (selected != null) rowPrograms.lastOrNull { it.stop <= selected.start + 1 }
                        else rowPrograms.lastOrNull { it.stop <= anchor }
                        when {
                            prev != null && prev.stop > earliest -> moveTo(maxOf(prev.start, earliest))
                            anchor - STEP >= earliest -> moveTo(anchor - STEP)
                        }
                    }
                    KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> moveTo(anchor + WINDOW)
                    KeyEvent.KEYCODE_MEDIA_REWIND -> moveTo(anchor - WINDOW)
                    KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER ->
                        if (selected != null) detail = selected else watch(row)
                    KeyEvent.KEYCODE_MEDIA_PLAY, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> watch(row)
                    KeyEvent.KEYCODE_GUIDE -> vm.screen = Screen.Watch
                    KeyEvent.KEYCODE_MENU -> vm.screen = Screen.Setup
                    else -> return@onPreviewKeyEvent false
                }
                true
            },
    ) {
        Column(Modifier.fillMaxSize().padding(horizontal = 36.dp, vertical = 22.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Guide", color = Tv.text, fontSize = 26.sp, fontWeight = FontWeight.Bold)
                Spacer(Modifier.width(18.dp))
                Text(dayLabel(windowStart), color = Tv.accent, fontSize = 20.sp)
                Spacer(Modifier.weight(1f))
                Text("OK details · ▶ watch · ⏪⏩ 2 hours · Menu settings · Back TV", color = Tv.muted, fontSize = 13.sp)
            }
            Spacer(Modifier.height(10.dp))
            ProgramSummary(selected, channel)
            Spacer(Modifier.height(12.dp))
            BoxWithConstraints(Modifier.fillMaxWidth().weight(1f)) {
                val timeline = maxWidth - CHANNEL_COL - 8.dp
                val dpPerSec = timeline.value / WINDOW
                Column {
                    TimeRuler(windowStart, timeline, dpPerSec, now)
                    LazyColumn(state = listState) {
                        itemsIndexed(channels, key = { _, c -> c.uuid }) { i, ch ->
                            GuideRow(
                                vm = vm, channel = ch, isRow = i == row, selected = selected,
                                windowStart = windowStart, dpPerSec = dpPerSec, now = now,
                            )
                        }
                    }
                }
            }
        }
        detail?.let { p ->
            ProgramDetails(vm, p, onClose = { detail = null }, onWatch = {
                val i = channels.indexOfFirst { it.uuid == p.channelUuid }
                detail = null
                if (i >= 0) watch(i)
            })
        }
    }
}

@Composable
private fun ProgramSummary(p: Program?, channel: Channel?) {
    val context = LocalContext.current
    Column(Modifier.fillMaxWidth().height(92.dp)) {
        if (p == null) {
            Text(channel?.label ?: "", color = Tv.text, fontSize = 22.sp, fontWeight = FontWeight.SemiBold)
            Text("No guide information here", color = Tv.muted, fontSize = 16.sp)
            return@Column
        }
        Text(p.title + if (p.subtitle.isNotBlank()) " · ${p.subtitle}" else "", color = Tv.text, fontSize = 22.sp,
            fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
        val genre = Genre.of(p)
        Text(
            listOfNotNull(dayLabel(p.start) + " " + timeRange(context, p.start, p.stop), channel?.label, genre?.label,
                if (p.isRecordingNow) "● Recording" else if (p.isScheduled) "● Will record" else null).joinToString("  ·  "),
            color = Tv.muted, fontSize = 15.sp, maxLines = 1,
        )
        Text(p.description, color = Tv.muted, fontSize = 15.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun TimeRuler(windowStart: Long, timeline: Dp, dpPerSec: Float, now: Long) {
    val context = LocalContext.current
    Row(Modifier.fillMaxWidth().height(28.dp)) {
        Spacer(Modifier.width(CHANNEL_COL + 8.dp))
        Box(Modifier.width(timeline).fillMaxHeight()) {
            var t = windowStart
            while (t < windowStart + WINDOW) {
                Text(timeOf(context, t), color = Tv.muted, fontSize = 14.sp, modifier = Modifier.offset(x = ((t - windowStart) * dpPerSec).dp))
                t += STEP
            }
            if (now in windowStart until windowStart + WINDOW) {
                Box(Modifier.offset(x = ((now - windowStart) * dpPerSec).dp - 5.dp, y = 16.dp).size(10.dp).background(Tv.accent, CircleShape))
            }
        }
    }
}

@Composable
private fun GuideRow(
    vm: AppViewModel,
    channel: Channel,
    isRow: Boolean,
    selected: Program?,
    windowStart: Long,
    dpPerSec: Float,
    now: Long,
) {
    val windowEnd = windowStart + WINDOW
    Row(Modifier.fillMaxWidth().height(ROW_HEIGHT).padding(vertical = 3.dp)) {
        Row(
            Modifier
                .width(CHANNEL_COL)
                .fillMaxHeight()
                .clip(RoundedCornerShape(8.dp))
                .background(if (isRow) Color(0x40F5B63F) else Tv.cell)
                .padding(horizontal = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(channel.number, color = Tv.accent, fontSize = 15.sp, fontWeight = FontWeight.Bold, modifier = Modifier.width(44.dp), maxLines = 1)
            ChannelLogo(channel, vm.imageLoader, 30.dp)
            Text(channel.name, color = Tv.text, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Spacer(Modifier.width(8.dp))
        Box(Modifier.weight(1f).fillMaxHeight()) {
            val programs = vm.programsFor(channel.uuid)
            if (programs.none { it.stop > windowStart && it.start < windowEnd }) {
                Text("No guide information", color = Tv.muted, fontSize = 14.sp, modifier = Modifier.align(Alignment.CenterStart).padding(start = 12.dp))
            }
            for (p in programs) {
                if (p.stop <= windowStart || p.start >= windowEnd) continue
                val s = maxOf(p.start, windowStart)
                val e = minOf(p.stop, windowEnd)
                ProgramTile(
                    p = p,
                    isSelected = isRow && selected?.eventId == p.eventId,
                    clippedStart = p.start < windowStart,
                    width = ((e - s) * dpPerSec).dp,
                    modifier = Modifier.offset(x = ((s - windowStart) * dpPerSec).dp),
                )
            }
            if (now in windowStart until windowEnd) {
                Box(Modifier.offset(x = ((now - windowStart) * dpPerSec).dp).width(2.dp).fillMaxHeight().background(Tv.accent))
            }
        }
    }
}

@Composable
private fun ProgramTile(p: Program, isSelected: Boolean, clippedStart: Boolean, width: Dp, modifier: Modifier) {
    val context = LocalContext.current
    val genre = Genre.of(p)
    val base = genre?.color?.copy(alpha = 0.30f) ?: Tv.cell
    Box(
        modifier
            .width((width - 3.dp).coerceAtLeast(3.dp))
            .fillMaxHeight()
            .clip(RoundedCornerShape(6.dp))
            .background(if (isSelected) Color(0xFFF5F7FA) else base)
            .then(if (isSelected) Modifier.border(2.dp, Tv.accent, RoundedCornerShape(6.dp)) else Modifier),
    ) {
        if (genre != null) Box(Modifier.fillMaxWidth().height(3.dp).background(genre.color))
        Column(Modifier.padding(horizontal = 8.dp, vertical = 6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (p.isScheduled) Box(Modifier.size(8.dp).background(Tv.rec, CircleShape))
                Text((if (clippedStart) "‹ " else "") + p.title, color = if (isSelected) Color.Black else Tv.text,
                    fontSize = 15.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (width > 110.dp) {
                Text(timeRange(context, p.start, p.stop), color = if (isSelected) Color(0xAA000000) else Tv.muted, fontSize = 12.sp, maxLines = 1)
            }
        }
    }
}

/** Details over the guide: Watch, Record / Cancel, Record series. */
@Composable
private fun ProgramDetails(vm: AppViewModel, p: Program, onClose: () -> Unit, onWatch: () -> Unit) {
    val context = LocalContext.current
    val first = remember { FocusRequester() }
    val nowS = nowSec()
    val channel = vm.channels.firstOrNull { it.uuid == p.channelUuid }
    LaunchedEffect(p.eventId) { first.requestFocus() }
    BackHandler { onClose() }
    Box(Modifier.fillMaxSize().background(Color(0xAA000000)), contentAlignment = Alignment.Center) {
        Column(
            Modifier
                .width(760.dp)
                .background(Tv.panelSolid, RoundedCornerShape(14.dp))
                .padding(30.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(p.title, color = Tv.text, fontSize = 28.sp, fontWeight = FontWeight.Bold)
            if (p.subtitle.isNotBlank()) Text(p.subtitle, color = Tv.muted, fontSize = 18.sp)
            Text(
                listOfNotNull(dayLabel(p.start) + " " + timeRange(context, p.start, p.stop), channel?.label, Genre.of(p)?.label).joinToString("  ·  "),
                color = Tv.muted, fontSize = 16.sp,
            )
            when {
                p.isRecordingNow -> Text("● Recording now", color = Tv.rec, fontSize = 16.sp)
                p.isScheduled -> Text("● Will be recorded", color = Tv.rec, fontSize = 16.sp)
            }
            if (p.description.isNotBlank()) Text(p.description, color = Tv.text, fontSize = 17.sp, maxLines = 7, overflow = TextOverflow.Ellipsis)
            Spacer(Modifier.height(6.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                TvButton(if (p.isAiring(nowS)) "Watch now" else "Watch channel", Modifier.focusRequester(first)) { onWatch() }
                if (p.isScheduled) {
                    TvButton(if (p.isRecordingNow) "Stop recording" else "Don’t record") { vm.cancelRecording(p); onClose() }
                } else if (p.stop > nowS) {
                    TvButton("Record") { vm.record(p); onClose() }
                    if (p.seriesLink.isNotBlank()) TvButton("Record series") { vm.record(p, series = true); onClose() }
                }
                TvButton("Close") { onClose() }
            }
        }
    }
}
