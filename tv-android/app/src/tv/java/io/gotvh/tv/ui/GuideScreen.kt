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
import androidx.compose.ui.draw.alpha
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
private val CHANNEL_COL = 220.dp
private val ROW_HEIGHT = 42.dp
private val RULER_HEIGHT = 28.dp

private fun alignDown(sec: Long) = sec - Math.floorMod(sec, STEP)

/**
 * The guide. Focus is one programme at a time ("virtual focus"): the grid keeps a channel row and a
 * point in time, so Up/Down stay at the same time of day, like a paper guide.
 *  Left/Right previous/next programme (the window scrolls at the edges) · Up/Down channel ·
 *  Ch+/Ch− a page of channels · ⏪/⏩ two hours · Menu · Back TV.
 *  OK: the programme's card (description; Watch first if it's on now, else Record) · ▶ watch the channel.
 */
@Composable
fun GuideScreen(vm: AppViewModel) {
    val context = LocalContext.current
    // Genre filter (null = all): only channels with something of that genre in the next 12 hours,
    // and that genre's programmes stand out. Chosen in the chip row above the grid (Up from the top).
    var genre by remember { mutableStateOf(vm.guideGenre) }
    val filterNow = nowSec() / 600 * 600
    val channels = remember(vm.channels, vm.programs, genre, filterNow) {
        val g = genre
        if (g == null) vm.channels else vm.channels.filter { ch ->
            vm.programsFor(ch.uuid).any { !it.placeholder && it.stop > filterNow && it.start < filterNow + 12 * 3600 && Genre.of(it) == g }
        }
    }
    /** The genre chips have the highlight (not the grid). */
    var onChips by remember { mutableStateOf(false) }
    val focus = remember { FocusRequester() }
    val listState = rememberLazyListState()
    var row by remember {
        val uuid = vm.channels.getOrNull(vm.guideRow)?.uuid
        mutableIntStateOf(channels.indexOfFirst { it.uuid == uuid }.coerceAtLeast(0))
    }
    LaunchedEffect(channels) { row = row.coerceIn(0, (channels.size - 1).coerceAtLeast(0)) }
    var now by remember { mutableLongStateOf(nowSec()) }
    val earliest = alignDown(now) - STEP
    var windowStart by remember { mutableLongStateOf(alignDown(nowSec())) }
    var anchor by remember { mutableLongStateOf(nowSec()) }
    var detail by remember { mutableStateOf<Program?>(null) }
    val windowEnd = windowStart + WINDOW

    val channel: Channel? = channels.getOrNull(row)
    val rowPrograms = channel?.let { vm.programsFor(it.uuid) }.orEmpty()
    val selected: Program? = rowPrograms.firstOrNull { it.start <= anchor && it.stop > anchor }
    // No programme listed at this time: the empty stretch around it is selectable, and OK watches the channel.
    val gap: Pair<Long, Long>? = if (selected != null || channel == null) null else Pair(
        maxOf(rowPrograms.lastOrNull { it.stop <= anchor }?.stop ?: windowStart, windowStart),
        minOf(rowPrograms.firstOrNull { it.start > anchor }?.start ?: windowEnd, windowEnd),
    )

    // Paging is exact: [top] is the first row on screen and [rows] how many fit completely, so
    // Ch+/Ch− move a whole page and every channel shows up on exactly one page.
    var rows by remember { mutableIntStateOf(8) }
    var top by remember { mutableIntStateOf((row - 2).coerceAtLeast(0)) }
    fun keepRowVisible() {
        val maxTop = (channels.size - rows).coerceAtLeast(0)
        if (row < top) top = row
        if (row >= top + rows) top = row - rows + 1
        top = top.coerceIn(0, maxTop)
    }
    fun page(dir: Int) {
        val maxTop = (channels.size - rows).coerceAtLeast(0)
        val offset = row - top
        top = (top + dir * rows).coerceIn(0, maxTop)
        row = (top + offset).coerceIn(0, (channels.size - 1).coerceAtLeast(0))
    }
    LaunchedEffect(Unit) {
        while (true) {
            delay(30_000)
            now = nowSec()
        }
    }
    LaunchedEffect(windowStart) { vm.ensureGuide(windowStart - 3600, windowStart + 6 * 3600) }
    LaunchedEffect(detail, vm.menuOpen) { if (detail == null && !vm.menuOpen) focus.requestFocus() }
    LaunchedEffect(row, rows) { keepRowVisible() }
    LaunchedEffect(top) { listState.scrollToItem(top) }

    BackHandler(enabled = detail == null) { if (onChips && channels.isNotEmpty()) onChips = false else vm.backToVideo() }

    /** Point the grid at [t], scrolling the window so it's comfortably on screen. */
    fun moveTo(t: Long) {
        anchor = t.coerceAtLeast(earliest)
        while (anchor < windowStart && windowStart > earliest) windowStart -= STEP
        while (anchor > windowStart + WINDOW - 1200) windowStart += STEP
    }

    fun watch(index: Int) {
        val uuid = channels.getOrNull(index)?.uuid ?: return
        // Same channel while a recording is loaded still means "switch to live TV".
        if (uuid != vm.currentChannel?.uuid || vm.recordingLoaded) vm.tuneUuid(uuid)
        vm.screen = Screen.Watch
    }
    val genres: List<Genre?> = listOf<Genre?>(null) + Genre.entries
    fun pickGenre(g: Genre?) {
        genre = g
        vm.guideGenre = g
        row = 0
        top = 0
    }

    Box(
        Modifier
            .fillMaxSize()
            .background(Color(0xF20B1220))
            .focusRequester(focus)
            .focusable()
            .onPreviewKeyEvent { ev ->
                if (detail != null) return@onPreviewKeyEvent false
                if (isHeldOk(ev)) return@onPreviewKeyEvent true
                if (ev.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                if (onChips || channels.isEmpty()) {
                    // The genre chips: Left/Right choose (the grid follows), Down / OK back to the grid.
                    val i = genres.indexOf(genre)
                    when (ev.nativeKeyEvent.keyCode) {
                        KeyEvent.KEYCODE_DPAD_LEFT -> pickGenre(genres[(i - 1).coerceAtLeast(0)])
                        KeyEvent.KEYCODE_DPAD_RIGHT -> pickGenre(genres[(i + 1).coerceAtMost(genres.size - 1)])
                        KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER ->
                            if (channels.isNotEmpty()) onChips = false
                        KeyEvent.KEYCODE_DPAD_UP -> {}
                        else -> return@onPreviewKeyEvent false
                    }
                    if (channels.isEmpty()) onChips = true
                    return@onPreviewKeyEvent true
                }
                when (ev.nativeKeyEvent.keyCode) {
                    KeyEvent.KEYCODE_DPAD_UP -> if (row == 0) onChips = true else row--
                    KeyEvent.KEYCODE_DPAD_DOWN -> row = (row + 1).coerceAtMost(channels.size - 1)
                    KeyEvent.KEYCODE_CHANNEL_UP, KeyEvent.KEYCODE_PAGE_UP -> page(-1)
                    KeyEvent.KEYCODE_CHANNEL_DOWN, KeyEvent.KEYCODE_PAGE_DOWN -> page(1)
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
                    // OK: the programme's card (Watch first if it's on now). Empty time: watch the channel.
                    KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER ->
                        if (selected != null) detail = selected else watch(row)
                    KeyEvent.KEYCODE_MEDIA_PLAY, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> watch(row)
                    KeyEvent.KEYCODE_GUIDE -> vm.backToVideo()
                    KeyEvent.KEYCODE_MENU -> vm.menuOpen = true
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
                Text(if (onChips) "◀ ▶ genre · ▼ back to the guide" else "OK details · ▶ watch · ⏪⏩ 2 hours · ▲ at the top: genres · Back TV",
                    color = Tv.muted, fontSize = 13.sp)
            }
            Spacer(Modifier.height(8.dp))
            // Genre chips: the chosen one is filled; the highlight ring shows when Up has moved here.
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                genres.forEach { g ->
                    val chosen = g == genre
                    Row(
                        Modifier
                            .clip(RoundedCornerShape(16.dp))
                            .background(if (chosen) (g?.color ?: Tv.accent) else Color(0x1FFFFFFF))
                            .then(if (chosen && onChips) Modifier.border(2.dp, Color.White, RoundedCornerShape(16.dp)) else Modifier)
                            .padding(horizontal = 12.dp, vertical = 5.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        if (g != null && !chosen) Box(Modifier.size(8.dp).background(g.color, CircleShape))
                        Text(g?.label ?: "All", color = if (chosen) Color.Black else Tv.text, fontSize = 14.sp,
                            fontWeight = if (chosen) FontWeight.Bold else FontWeight.Normal)
                    }
                }
                if (genre != null) Text("${channels.size} channels", color = Tv.muted, fontSize = 13.sp)
            }
            Spacer(Modifier.height(10.dp))
            if (channels.isEmpty() && genre != null) {
                Text("Nothing in ${genre?.label} in the next 12 hours. ◀ ▶ another genre.", color = Tv.muted, fontSize = 18.sp)
            }
            ProgramSummary(selected, channel, isNow = anchor <= now + 60)
            Spacer(Modifier.height(12.dp))
            BoxWithConstraints(Modifier.fillMaxWidth().weight(1f)) {
                val timeline = maxWidth - CHANNEL_COL - 8.dp
                val dpPerSec = timeline.value / WINDOW
                // Whole rows that fit under the time ruler: one page.
                val fit = ((maxHeight - RULER_HEIGHT) / ROW_HEIGHT).toInt().coerceAtLeast(1)
                LaunchedEffect(fit) { rows = fit }
                Column {
                    TimeRuler(windowStart, timeline, dpPerSec, now)
                    // Scrolled only by the page logic above (no scrolling of its own), so pages stay exact.
                    LazyColumn(state = listState, userScrollEnabled = false) {
                        itemsIndexed(channels, key = { _, c -> c.uuid }) { i, ch ->
                            GuideRow(
                                vm = vm, channel = ch, isRow = i == row && !onChips, selected = selected, gap = if (i == row && !onChips) gap else null,
                                windowStart = windowStart, dpPerSec = dpPerSec, now = now, genre = genre,
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
private fun ProgramSummary(p: Program?, channel: Channel?, isNow: Boolean) {
    val context = LocalContext.current
    Column(Modifier.fillMaxWidth().height(92.dp)) {
        if (p == null || p.placeholder) {
            Text(channel?.label ?: "", color = Tv.text, fontSize = 22.sp, fontWeight = FontWeight.SemiBold)
            Text(
                if (isNow) "Nothing listed in the guide right now · OK to watch this channel"
                else "Nothing listed in the guide at this time · OK to watch this channel",
                color = Tv.muted, fontSize = 16.sp,
            )
            return@Column
        }
        Text(p.title + if (p.subtitle.isNotBlank()) " · ${p.subtitle}" else "", color = Tv.text, fontSize = 22.sp,
            fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
        val genre = Genre.of(p)
        Text(
            listOfNotNull(dayLabel(p.start) + " " + timeRange(context, p.start, p.stop), channel?.label, genre?.label, p.released,
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
    gap: Pair<Long, Long>?,
    windowStart: Long,
    dpPerSec: Float,
    now: Long,
    genre: Genre? = null,
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
            ChannelLogo(channel, vm.imageLoader, 26.dp)
            Text(channel.name, color = Tv.text, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Spacer(Modifier.width(8.dp))
        Box(Modifier.weight(1f).fillMaxHeight()) {
            val programs = vm.programsFor(channel.uuid)
            // Only while the guide for this stretch is still loading: loaded time always has blocks.
            if (gap == null && programs.none { it.stop > windowStart && it.start < windowEnd }) {
                Text("No guide information", color = Tv.muted, fontSize = 14.sp, modifier = Modifier.align(Alignment.CenterStart).padding(start = 12.dp))
            }
            if (gap != null && gap.second > gap.first) {
                // The selected empty stretch: highlighted like a programme, OK watches the channel.
                Box(
                    Modifier
                        .offset(x = ((gap.first - windowStart) * dpPerSec).dp)
                        .width((((gap.second - gap.first) * dpPerSec).dp - 3.dp).coerceAtLeast(3.dp))
                        .fillMaxHeight()
                        .clip(RoundedCornerShape(6.dp))
                        .background(Color(0xFFF5F7FA))
                        .border(2.dp, Tv.accent, RoundedCornerShape(6.dp))
                        .padding(horizontal = 10.dp),
                    contentAlignment = Alignment.CenterStart,
                ) {
                    Text("Nothing listed · OK to watch", color = Color.Black, fontSize = 15.sp, fontWeight = FontWeight.Medium,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
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
                    // Filtering by genre: the other programmes fade back.
                    dim = genre != null && Genre.of(p) != genre,
                )
            }
            if (now in windowStart until windowEnd) {
                Box(Modifier.offset(x = ((now - windowStart) * dpPerSec).dp).width(2.dp).fillMaxHeight().background(Tv.accent))
            }
        }
    }
}

@Composable
private fun ProgramTile(p: Program, isSelected: Boolean, clippedStart: Boolean, width: Dp, modifier: Modifier, dim: Boolean = false) {
    val context = LocalContext.current
    val genre = if (p.placeholder) null else Genre.of(p)
    // Placeholders are fainter than real programmes, so it's clear the guide lists nothing there.
    val base = genre?.color?.copy(alpha = 0.30f) ?: if (p.placeholder) Color(0x14FFFFFF) else Tv.cell
    Box(
        modifier
            .width((width - 3.dp).coerceAtLeast(3.dp))
            .fillMaxHeight()
            .alpha(if (dim && !isSelected) 0.35f else 1f)
            .clip(RoundedCornerShape(6.dp))
            .background(if (isSelected) Color(0xFFF5F7FA) else base)
            .then(if (isSelected) Modifier.border(2.dp, Tv.accent, RoundedCornerShape(6.dp)) else Modifier),
    ) {
        if (genre != null) Box(Modifier.fillMaxWidth().height(3.dp).background(genre.color))
        // One line: the title (times are on the ruler above, and in the summary for the selected one).
        Box(Modifier.fillMaxHeight().padding(horizontal = 8.dp), contentAlignment = Alignment.CenterStart) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (p.isScheduled) Box(Modifier.size(8.dp).background(Tv.rec, CircleShape))
                Text((if (clippedStart) "‹ " else "") + p.title, color = if (isSelected) Color.Black else if (p.placeholder) Tv.muted else Tv.text,
                    fontSize = 15.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

/** A programme's card (kept under this name for the screens that use it). */
@Composable
internal fun ProgramDetails(vm: AppViewModel, p: Program, onClose: () -> Unit, onWatch: () -> Unit) =
    ProgramCard(vm, p, onClose, onWatch)
