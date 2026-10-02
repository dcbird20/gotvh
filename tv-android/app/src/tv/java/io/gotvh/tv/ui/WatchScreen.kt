package io.gotvh.tv.ui

import android.view.KeyEvent
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
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
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
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
import io.gotvh.tv.Screen
import io.gotvh.tv.data.Program
import io.gotvh.tv.nowSec
import kotlinx.coroutines.delay

private const val BANNER_MS = 4000L
private const val CONTROLS_IDLE_MS = 8000L
private const val LIST_PAGE = 8
private const val BACK_MS = 10_000L
private const val FORWARD_MS = 30_000L

/**
 * Live TV. With nothing on screen the keys never change meaning:
 *  OK the controls · Left / Right back 10 s / forward 30 s (into Tvheadend's pause buffer; forward
 *  stops at live) · Up / Down next / previous channel · digits a channel number · Back the menu.
 * The controls (all real focus: arrows move the highlight, OK presses, Back closes):
 *  progress row (Left/Right move) · ⏯ · Info · Guide · Channels · 123 · Recordings · Search ·
 *  Record (· Live when behind) · the mini guide below (OK on a programme: its card).
 * ⏯ ⏪ ⏩ Guide Ch± keys work any time, on remotes that have them.
 */
@Composable
fun WatchScreen(vm: AppViewModel) {
    val player = vm.player
    val channels = vm.channels
    val root = remember { FocusRequester() }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    var lastKey by remember { mutableLongStateOf(System.currentTimeMillis()) }
    var bannerUntil by remember { mutableLongStateOf(System.currentTimeMillis() + BANNER_MS) }
    var controls by remember { mutableStateOf(false) }
    var listOpen by remember { mutableStateOf(false) }
    var listIndex by remember { mutableIntStateOf(vm.currentIndex) }
    var padOpen by remember { mutableStateOf(false) }
    var card by remember { mutableStateOf<Program?>(null) }
    var digits by remember { mutableStateOf("") }
    val overlay = listOpen || padOpen || card != null

    fun showBanner() {
        now = System.currentTimeMillis()
        bannerUntil = now + BANNER_MS
    }
    fun openList() {
        controls = false
        listIndex = vm.currentIndex
        listOpen = true
    }
    fun openGuide(row: Int) {
        controls = false
        vm.guideRow = row
        vm.screen = Screen.Guide
    }

    LaunchedEffect(Unit) {
        while (true) {
            delay(500)
            now = System.currentTimeMillis()
            // The controls go away once you stop using them (nothing else changes when they do).
            if (controls && !overlay && now - lastKey > CONTROLS_IDLE_MS) controls = false
        }
    }
    // The root takes the keys whenever nothing focusable is on screen.
    LaunchedEffect(controls, overlay, vm.menuOpen) {
        if (!controls && !overlay && !vm.menuOpen) runCatching { root.requestFocus() }
    }
    LaunchedEffect(vm.currentIndex) { showBanner() }
    LaunchedEffect(vm.requestChannelList) {
        if (vm.requestChannelList) {
            vm.requestChannelList = false
            openList()
        }
    }
    LaunchedEffect(digits) {
        if (digits.isEmpty()) return@LaunchedEffect
        delay(1500)
        val i = vm.indexForNumber(digits)
        if (i >= 0) vm.tune(i) else vm.notice = "No channel $digits"
        digits = ""
    }

    // Back: close what's open, step by step; with nothing open, the menu. Never stops the picture.
    BackHandler(enabled = !vm.menuOpen && card == null && !padOpen) {
        when {
            listOpen -> listOpen = false
            controls -> controls = false
            else -> vm.menuOpen = true
        }
    }

    Box(
        Modifier
            .fillMaxSize()
            .onPreviewKeyEvent { ev ->
                if (ev.type == KeyEventType.KeyDown) lastKey = System.currentTimeMillis()
                if (card != null || padOpen) return@onPreviewKeyEvent false
                if (isHeldOk(ev)) return@onPreviewKeyEvent true
                if (ev.type != KeyEventType.KeyDown || channels.isEmpty()) return@onPreviewKeyEvent false
                val k = ev.nativeKeyEvent.keyCode
                // Keys that do the same thing everywhere on this screen.
                when (k) {
                    KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_SPACE -> { player.togglePause(); showBanner(); return@onPreviewKeyEvent true }
                    KeyEvent.KEYCODE_MEDIA_PAUSE -> { player.pauseLive(); showBanner(); return@onPreviewKeyEvent true }
                    KeyEvent.KEYCODE_MEDIA_PLAY -> { player.resumeLive(); showBanner(); return@onPreviewKeyEvent true }
                    KeyEvent.KEYCODE_MEDIA_REWIND -> { player.seekLive(-BACK_MS); showBanner(); return@onPreviewKeyEvent true }
                    KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> { player.seekLive(FORWARD_MS); showBanner(); return@onPreviewKeyEvent true }
                    KeyEvent.KEYCODE_MEDIA_NEXT -> { player.goLive(); showBanner(); return@onPreviewKeyEvent true }
                    KeyEvent.KEYCODE_CHANNEL_UP -> if (!listOpen) { vm.tune(vm.currentIndex + 1); return@onPreviewKeyEvent true }
                    KeyEvent.KEYCODE_CHANNEL_DOWN -> if (!listOpen) { vm.tune(vm.currentIndex - 1); return@onPreviewKeyEvent true }
                    KeyEvent.KEYCODE_GUIDE -> { openGuide(vm.currentIndex); return@onPreviewKeyEvent true }
                    KeyEvent.KEYCODE_MENU -> { vm.menuOpen = true; return@onPreviewKeyEvent true }
                    KeyEvent.KEYCODE_LAST_CHANNEL -> { vm.tunePrevious(); return@onPreviewKeyEvent true }
                    in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9 -> {
                        digits += (k - KeyEvent.KEYCODE_0).toString()
                        showBanner()
                        return@onPreviewKeyEvent true
                    }
                }
                if (listOpen) {
                    when (k) {
                        KeyEvent.KEYCODE_DPAD_UP -> listIndex = Math.floorMod(listIndex - 1, channels.size)
                        KeyEvent.KEYCODE_DPAD_DOWN -> listIndex = Math.floorMod(listIndex + 1, channels.size)
                        KeyEvent.KEYCODE_CHANNEL_UP, KeyEvent.KEYCODE_PAGE_UP -> listIndex = (listIndex - LIST_PAGE).coerceAtLeast(0)
                        KeyEvent.KEYCODE_CHANNEL_DOWN, KeyEvent.KEYCODE_PAGE_DOWN -> listIndex = (listIndex + LIST_PAGE).coerceAtMost(channels.size - 1)
                        KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> {
                            vm.tune(listIndex)
                            listOpen = false
                        }
                        KeyEvent.KEYCODE_DPAD_LEFT -> listOpen = false
                        else -> return@onPreviewKeyEvent true // nothing else moves while the list is open
                    }
                    return@onPreviewKeyEvent true
                }
                if (controls) return@onPreviewKeyEvent false // real focus inside the controls
                // Nothing on screen: these four never change.
                when (k) {
                    KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER, KeyEvent.KEYCODE_INFO -> controls = true
                    KeyEvent.KEYCODE_DPAD_LEFT -> { player.seekLive(-BACK_MS); showBanner() }
                    KeyEvent.KEYCODE_DPAD_RIGHT -> { if (player.isBehindLive) player.seekLive(FORWARD_MS); showBanner() }
                    KeyEvent.KEYCODE_DPAD_UP -> vm.tune(vm.currentIndex + 1)
                    KeyEvent.KEYCODE_DPAD_DOWN -> vm.tune(vm.currentIndex - 1)
                    else -> return@onPreviewKeyEvent false
                }
                true
            }
            .focusRequester(root)
            .focusable(),
    ) {
        // Tuning / problem messages.
        val message = player.status ?: when {
            vm.loading && channels.isEmpty() -> "Connecting to Tvheadend…"
            player.tuning -> "Tuning…"
            else -> null
        }
        if (message != null) {
            Box(Modifier.fillMaxSize().padding(40.dp), contentAlignment = Alignment.Center) {
                Text(message, color = Tv.text, fontSize = 20.sp,
                    modifier = Modifier.background(Tv.panel, RoundedCornerShape(12.dp)).padding(horizontal = 26.dp, vertical = 16.dp))
            }
        }
        if (digits.isNotEmpty()) {
            Box(Modifier.fillMaxSize().padding(36.dp), contentAlignment = Alignment.TopEnd) {
                Text(digits, color = Tv.accent, fontSize = 56.sp, fontWeight = FontWeight.Bold,
                    modifier = Modifier.background(Tv.panel, RoundedCornerShape(12.dp)).padding(horizontal = 24.dp, vertical = 6.dp))
            }
        }

        val shifted = player.paused || player.isBehindLive
        when {
            listOpen -> ChannelList(vm, listIndex)
            controls -> {
                val on = vm.currentChannel?.let { vm.nowAndNext(it.uuid, playingSec(vm)).first }
                val buttons = buildList<Pair<String, () -> Unit>> {
                    if (player.canPause) add((if (player.paused) "▶  Play" else "❚❚  Pause") to { player.togglePause() })
                    add("ⓘ  Info" to { on?.let { card = it } ?: run { vm.notice = "Nothing in the guide for this channel now." } })
                    add("▦  Guide" to { openGuide(vm.currentIndex) })
                    add("☰  Channels" to { openList() })
                    add("123" to { padOpen = true })
                    add("Recordings" to { controls = false; vm.open(Screen.Recordings) })
                    add("⌕  Search" to { controls = false; vm.open(Screen.Search) })
                    add((if (on?.isScheduled == true) "■  Stop recording" else "●  Record") to { recordWatched(vm) })
                    if (shifted) add("⏭  Live" to { player.goLive() })
                }
                PlayerControls(
                    header = { ChannelHeader(vm) },
                    progress = { focused -> TimeshiftProgress(vm, focused) },
                    onScrub = { forward -> player.seekLive(if (forward) FORWARD_MS else -BACK_MS) },
                    buttons = buttons,
                    below = { MiniGuide(vm, interactive = true, onPick = { card = it }) },
                )
            }
            now < bannerUntil -> Banner { ChannelHeader(vm); TimeshiftProgress(vm, false); MiniGuide(vm, interactive = false, onPick = {}) }
            shifted -> Badge(if (player.paused) "❚❚  Paused" else "▶  −" + clock(player.behindLiveMs))
        }

        if (padOpen) {
            NumberPad(
                onTune = { number ->
                    val i = vm.indexForNumber(number)
                    if (i >= 0) {
                        padOpen = false
                        controls = false
                        vm.tune(i)
                    } else {
                        vm.notice = "No channel $number"
                    }
                },
                onClose = { padOpen = false },
            )
        }
        card?.let { p ->
            ProgramCard(
                vm, p,
                onClose = { card = null },
                // Already watching this channel: no Watch button for what's on now.
                onWatch = if (p.channelUuid == vm.currentChannel?.uuid && p.isAiring(nowSec())) null else ({
                    controls = false
                    vm.tuneUuid(p.channelUuid)
                }),
            )
        }
    }
}

/**
 * Record (or stop recording) the programme on screen — when watching behind live, the one at the
 * paused / rewound point. Tvheadend records from now; what's already gone by isn't in the recording.
 */
private fun recordWatched(vm: AppViewModel) {
    val ch = vm.currentChannel ?: return
    val p = vm.nowAndNext(ch.uuid, playingSec(vm)).first
    when {
        p == null -> vm.notice = "Nothing in the guide to record here."
        p.isScheduled -> vm.cancelRecording(p)
        else -> vm.record(p)
    }
}

/** The broadcast time on screen: now, or earlier when paused / behind live. */
private fun playingSec(vm: AppViewModel): Long = nowSec() - vm.player.behindLiveMs / 1000

/** The bottom banner without controls (after changing channel or skipping). */
@Composable
private fun Banner(content: @Composable ColumnScope.() -> Unit) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.BottomCenter) {
        Column(
            Modifier
                .fillMaxWidth()
                .background(Brush.verticalGradient(listOf(Color.Transparent, Color(0xE00B1220), Color(0xF50B1220))))
                .padding(start = 48.dp, end = 48.dp, top = 70.dp, bottom = 30.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
            content = content,
        )
    }
}

@Composable
private fun Badge(text: String) {
    Box(Modifier.fillMaxSize().padding(36.dp), contentAlignment = Alignment.TopStart) {
        Text(text, color = Tv.accent, fontSize = 20.sp, fontWeight = FontWeight.SemiBold,
            modifier = Modifier.background(Tv.panel, RoundedCornerShape(10.dp)).padding(horizontal = 16.dp, vertical = 8.dp))
    }
}

/** Channel and the programme on screen (at the paused / rewound point when behind live). */
@Composable
private fun ChannelHeader(vm: AppViewModel) {
    val context = LocalContext.current
    val ch = vm.currentChannel ?: return
    val at = playingSec(vm)
    val current = vm.nowAndNext(ch.uuid, at).first
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(24.dp)) {
        ChannelLogo(ch, vm.imageLoader, 80.dp)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                if (ch.number.isNotEmpty()) Text(ch.number, color = Tv.accent, fontSize = 28.sp, fontWeight = FontWeight.Bold)
                Text(ch.name, color = Tv.text, fontSize = 24.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (current?.isRecordingNow == true) Box(Modifier.size(14.dp).background(Tv.rec, CircleShape))
            }
            if (current != null) {
                Text(current.title + if (current.subtitle.isNotBlank()) " · ${current.subtitle}" else "",
                    color = Tv.text, fontSize = 21.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    Text(timeRange(context, current.start, current.stop), color = Tv.muted, fontSize = 15.sp)
                    val f = ((at - current.start).toFloat() / (current.stop - current.start).coerceAtLeast(1)).coerceIn(0f, 1f)
                    Box(Modifier.weight(1f).height(4.dp).background(Color(0x33FFFFFF), RoundedCornerShape(2.dp))) {
                        Box(Modifier.fillMaxHeight().fillMaxWidth(f).background(Color(0x99FFFFFF), RoundedCornerShape(2.dp)))
                    }
                    Text("${((current.stop - at).coerceAtLeast(0) + 59) / 60} min left", color = Tv.muted, fontSize = 15.sp)
                }
            } else {
                Text("No guide information", color = Tv.muted, fontSize = 17.sp)
            }
        }
    }
}

/** Where you are in Tvheadend's pause buffer: LIVE, or paused / behind live by how much. */
@Composable
private fun TimeshiftProgress(vm: AppViewModel, focused: Boolean) {
    val p = vm.player
    if (!p.canPause) {
        Text(p.pauseUnavailable ?: "● LIVE", color = Tv.muted, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        return
    }
    val behind = p.behindLiveMs
    val span = p.liveBufferMs.coerceAtLeast(1)
    val shifted = p.paused || p.isBehindLive
    ProgressLine(
        fraction = 1f - behind.toFloat() / span,
        left = when {
            p.paused -> "❚❚  Paused · −" + clock(behind)
            shifted -> "−" + clock(behind) + " behind live"
            else -> "●  LIVE"
        },
        right = "Can rewind ${clock(span)}",
        accent = if (shifted) Tv.accent else Color(0x99FFFFFF),
        hint = if (focused) "◀ −10 s   ·   +30 s ▶" else null,
    )
}

/** What's coming up on this channel. In the controls, each programme can be picked (OK: its card). */
@Composable
private fun MiniGuide(vm: AppViewModel, interactive: Boolean, onPick: (Program) -> Unit) {
    val context = LocalContext.current
    val ch = vm.currentChannel ?: return
    val later = vm.upNext(ch.uuid, 5)
    if (later.isEmpty()) return
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        later.forEachIndexed { i, p ->
            val body: @Composable (Boolean) -> Unit = { focused ->
                Column(Modifier.padding(horizontal = 14.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text((if (i == 0) "Next · " else "") + timeOf(context, p.start),
                        color = if (focused) Color(0xAA000000) else if (i == 0) Tv.accent else Tv.muted, fontSize = 14.sp)
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        if (p.isScheduled) Box(Modifier.size(8.dp).background(Tv.rec, CircleShape))
                        Text(p.title, color = if (focused) Color.Black else Tv.text, fontSize = 16.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            if (interactive) {
                TvTile(Modifier.weight(1f), onClick = { onPick(p) }) { focused -> body(focused) }
            } else {
                Box(Modifier.weight(1f).background(Color(0x1FFFFFFF), RoundedCornerShape(10.dp))) { body(false) }
            }
        }
        repeat(5 - later.size) { Spacer(Modifier.weight(1f)) }
    }
}

/** Left panel with every channel and what's on it now. Up/Down move, OK tunes, Back / Left close. */
@Composable
private fun ChannelList(vm: AppViewModel, selected: Int) {
    val context = LocalContext.current
    val state = rememberLazyListState()
    LaunchedEffect(selected) { state.scrollToItem((selected - 4).coerceAtLeast(0)) }
    val nowS = nowSec()
    Box(Modifier.fillMaxHeight().width(520.dp).background(Tv.panel).padding(vertical = 24.dp)) {
        LazyColumn(state = state) {
            itemsIndexed(vm.channels, key = { _, c -> c.uuid }) { i, ch ->
                val isSel = i == selected
                val (current, next) = vm.nowAndNext(ch.uuid, nowS)
                Row(
                    Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 14.dp, vertical = 2.dp)
                        .background(if (isSel) Tv.accent else Color.Transparent, RoundedCornerShape(8.dp))
                        .padding(horizontal = 12.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    val fg = if (isSel) Color.Black else Tv.text
                    Text(ch.number, color = if (isSel) Color.Black else Tv.accent, fontSize = 17.sp, fontWeight = FontWeight.Bold, modifier = Modifier.width(52.dp))
                    ChannelLogo(ch, vm.imageLoader, 34.dp)
                    Column(Modifier.weight(1f)) {
                        Text(ch.name, color = fg, fontSize = 17.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(current?.title ?: "No guide information", color = if (isSel) Color(0xCC000000) else Tv.muted, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (current != null) {
                            val f = ((nowS - current.start).toFloat() / (current.stop - current.start).coerceAtLeast(1)).coerceIn(0f, 1f)
                            Box(Modifier.padding(vertical = 3.dp).fillMaxWidth(0.6f).height(3.dp).background(if (isSel) Color(0x33000000) else Color(0x33FFFFFF))) {
                                Box(Modifier.fillMaxHeight().fillMaxWidth(f).background(if (isSel) Color.Black else Tv.accent))
                            }
                        }
                        if (next != null) {
                            Text("Next ${timeOf(context, next.start)} ${next.title}", color = if (isSel) Color(0x99000000) else Tv.muted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                    if (i == vm.currentIndex) Spacer(Modifier.size(8.dp).background(if (isSel) Color.Black else Tv.accent, CircleShape))
                }
            }
        }
    }
}
