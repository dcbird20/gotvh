package io.gotvh.tv.ui

import android.app.Activity
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
import io.gotvh.tv.nowSec
import kotlinx.coroutines.delay

private const val BANNER_MS = 5000L
private const val LIST_PAGE = 8

private const val BACK_MS = 10_000L
private const val FORWARD_MS = 30_000L

/**
 * Full-screen TV. Keys at live:
 *  Up / Ch+ next channel · Down / Ch− previous · Left channel list · Right / Guide the guide ·
 *  OK pause (on a channel that can't pause: info banner, OK again channel list) ·
 *  Menu the menu · digits jump to a number · Last channel · Back closes what's open, then the menu.
 * Paused or behind live (Tvheadend's timeshift buffer, over HTSP), the playback bar takes over:
 *  OK play / pause · Left back 10 s · Right forward 30 s (forward past live = live) ·
 *  Down to its buttons — Channels · Guide · Live — Left/Right to choose, OK to open, Up/Back to leave.
 * ⏯ ⏪ ⏩ work any time.
 */
@Composable
fun WatchScreen(vm: AppViewModel) {
    val context = LocalContext.current
    val focus = remember { FocusRequester() }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    var bannerUntil by remember { mutableLongStateOf(System.currentTimeMillis() + BANNER_MS) }
    var listOpen by remember { mutableStateOf(false) }
    var listIndex by remember { mutableIntStateOf(vm.currentIndex) }
    var digits by remember { mutableStateOf("") }
    /** Which playback-bar button is selected (0 Channels, 1 Guide, 2 Live), or null while scrubbing. */
    var button by remember { mutableStateOf<Int?>(null) }
    val player = vm.player
    // Paused or watching behind live: the arrows rewind / go forward, and the bar has the buttons.
    val shifted = player.canPause && (player.paused || player.isBehindLive)
    val bannerVisible = now < bannerUntil || player.paused || button != null
    val channels = vm.channels

    fun showBanner() {
        now = System.currentTimeMillis()
        bannerUntil = now + BANNER_MS
    }

    fun openList() {
        button = null
        listIndex = vm.currentIndex
        listOpen = true
    }

    fun openGuide(row: Int) {
        button = null
        vm.guideRow = row
        vm.screen = Screen.Guide
    }

    LaunchedEffect(Unit) { focus.requestFocus() }
    LaunchedEffect(vm.menuOpen) { if (!vm.menuOpen) focus.requestFocus() }
    LaunchedEffect(Unit) {
        while (true) {
            delay(1000)
            now = System.currentTimeMillis()
        }
    }
    LaunchedEffect(vm.currentIndex) { showBanner() }
    LaunchedEffect(shifted) { if (!shifted) button = null }
    LaunchedEffect(digits) {
        if (digits.isEmpty()) return@LaunchedEffect
        delay(1500)
        val i = vm.indexForNumber(digits)
        if (i >= 0) vm.tune(i) else vm.notice = "No channel $digits"
        digits = ""
    }

    // Google TV remotes have no Menu key, so Back on full-screen TV opens the menu.
    BackHandler(enabled = !vm.menuOpen) {
        when {
            listOpen -> listOpen = false
            button != null -> button = null
            bannerVisible && !player.paused -> bannerUntil = 0
            else -> vm.menuOpen = true
        }
    }

    Box(
        Modifier
            .fillMaxSize()
            .focusRequester(focus)
            .focusable()
            .onPreviewKeyEvent { ev ->
                if (isHeldOk(ev)) return@onPreviewKeyEvent true
                if (ev.type != KeyEventType.KeyDown || channels.isEmpty()) return@onPreviewKeyEvent false
                val k = ev.nativeKeyEvent.keyCode
                val ok = k == KeyEvent.KEYCODE_DPAD_CENTER || k == KeyEvent.KEYCODE_ENTER || k == KeyEvent.KEYCODE_NUMPAD_ENTER
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
                        KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.KEYCODE_GUIDE -> openGuide(listIndex)
                        else -> return@onPreviewKeyEvent false
                    }
                    return@onPreviewKeyEvent true
                }
                // Keys that mean the same everywhere.
                when (k) {
                    KeyEvent.KEYCODE_CHANNEL_UP -> { vm.tune(vm.currentIndex + 1); return@onPreviewKeyEvent true }
                    KeyEvent.KEYCODE_CHANNEL_DOWN -> { vm.tune(vm.currentIndex - 1); return@onPreviewKeyEvent true }
                    KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_SPACE -> { player.togglePause(); showBanner(); return@onPreviewKeyEvent true }
                    KeyEvent.KEYCODE_MEDIA_PAUSE -> { player.pauseLive(); showBanner(); return@onPreviewKeyEvent true }
                    KeyEvent.KEYCODE_MEDIA_PLAY -> { player.resumeLive(); showBanner(); return@onPreviewKeyEvent true }
                    KeyEvent.KEYCODE_MEDIA_REWIND -> { player.seekLive(-BACK_MS); showBanner(); return@onPreviewKeyEvent true }
                    KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> { player.seekLive(FORWARD_MS); showBanner(); return@onPreviewKeyEvent true }
                    KeyEvent.KEYCODE_MEDIA_NEXT -> { player.goLive(); showBanner(); return@onPreviewKeyEvent true }
                    KeyEvent.KEYCODE_GUIDE -> { openGuide(vm.currentIndex); return@onPreviewKeyEvent true }
                    KeyEvent.KEYCODE_MENU -> { vm.menuOpen = true; return@onPreviewKeyEvent true }
                    KeyEvent.KEYCODE_INFO -> { showBanner(); return@onPreviewKeyEvent true }
                    KeyEvent.KEYCODE_LAST_CHANNEL -> { vm.tunePrevious(); return@onPreviewKeyEvent true }
                    in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9 -> {
                        digits += (k - KeyEvent.KEYCODE_0).toString()
                        showBanner()
                        return@onPreviewKeyEvent true
                    }
                }
                val b = button
                when {
                    // On the playback bar's buttons.
                    b != null -> when {
                        k == KeyEvent.KEYCODE_DPAD_LEFT -> button = (b - 1).coerceAtLeast(0)
                        k == KeyEvent.KEYCODE_DPAD_RIGHT -> button = (b + 1).coerceAtMost(2)
                        k == KeyEvent.KEYCODE_DPAD_UP -> { button = null; showBanner() }
                        ok -> when (b) {
                            0 -> openList()
                            1 -> openGuide(vm.currentIndex)
                            else -> { button = null; player.goLive(); showBanner() }
                        }
                        else -> return@onPreviewKeyEvent false
                    }
                    // Paused or behind live: the playback bar.
                    shifted -> when {
                        ok -> { player.togglePause(); showBanner() }
                        k == KeyEvent.KEYCODE_DPAD_LEFT -> { player.seekLive(-BACK_MS); showBanner() }
                        k == KeyEvent.KEYCODE_DPAD_RIGHT -> { player.seekLive(FORWARD_MS); showBanner() }
                        k == KeyEvent.KEYCODE_DPAD_DOWN -> { button = 0; showBanner() }
                        k == KeyEvent.KEYCODE_DPAD_UP -> showBanner()
                        else -> return@onPreviewKeyEvent false
                    }
                    // At live.
                    else -> when {
                        k == KeyEvent.KEYCODE_DPAD_UP -> vm.tune(vm.currentIndex + 1)
                        k == KeyEvent.KEYCODE_DPAD_DOWN -> vm.tune(vm.currentIndex - 1)
                        k == KeyEvent.KEYCODE_DPAD_LEFT -> openList()
                        k == KeyEvent.KEYCODE_DPAD_RIGHT -> openGuide(vm.currentIndex)
                        ok && player.canPause -> { player.pauseLive(); showBanner() }
                        ok -> if (bannerVisible) openList() else showBanner()
                        else -> return@onPreviewKeyEvent false
                    }
                }
                true
            },
    ) {
        // Tuning / problem messages.
        val message = player.status ?: when {
            vm.loading && channels.isEmpty() -> "Connecting to Tvheadend…"
            player.tuning -> "Tuning…"
            else -> null
        }
        if (message != null) {
            Box(Modifier.fillMaxSize().padding(40.dp), contentAlignment = Alignment.Center) {
                Text(
                    message, color = Tv.text, fontSize = 20.sp,
                    modifier = Modifier.background(Tv.panel, RoundedCornerShape(12.dp)).padding(horizontal = 26.dp, vertical = 16.dp),
                )
            }
        }

        if (digits.isNotEmpty()) {
            Box(Modifier.fillMaxSize().padding(36.dp), contentAlignment = Alignment.TopEnd) {
                Text(digits, color = Tv.accent, fontSize = 56.sp, fontWeight = FontWeight.Bold,
                    modifier = Modifier.background(Tv.panel, RoundedCornerShape(12.dp)).padding(horizontal = 24.dp, vertical = 6.dp))
            }
        }

        if (bannerVisible && !listOpen) ChannelBanner(vm, button)
        // Banner hidden: still show that it's paused or behind live.
        if (!bannerVisible && (player.paused || player.isBehindLive)) {
            Box(Modifier.fillMaxSize().padding(36.dp), contentAlignment = Alignment.TopStart) {
                Text(
                    if (player.paused) "❚❚  Paused" else "▶  −" + clock(player.behindLiveMs),
                    color = Tv.accent, fontSize = 20.sp, fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.background(Tv.panel, RoundedCornerShape(10.dp)).padding(horizontal = 16.dp, vertical = 8.dp),
                )
            }
        }
        if (listOpen) ChannelList(vm, listIndex)
    }
}

/** Bottom banner: channel, what's on now with progress, and what's next. */
@Composable
private fun ChannelBanner(vm: AppViewModel, button: Int?) {
    val context = LocalContext.current
    val ch = vm.currentChannel ?: return
    val nowS = nowSec()
    val current = vm.nowAndNext(ch.uuid, nowS).first
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.BottomCenter) {
        Column(
            Modifier
                .fillMaxWidth()
                .background(Brush.verticalGradient(listOf(Color.Transparent, Color(0xE00B1220), Color(0xF50B1220))))
                .padding(start = 48.dp, end = 48.dp, top = 70.dp, bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            // Channel and what's on now.
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                ChannelLogo(ch, vm.imageLoader, 88.dp)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                        if (ch.number.isNotEmpty()) Text(ch.number, color = Tv.accent, fontSize = 30.sp, fontWeight = FontWeight.Bold)
                        Text(ch.name, color = Tv.text, fontSize = 26.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f, fill = false))
                        if (current?.isRecordingNow == true) Box(Modifier.size(14.dp).background(Tv.rec, CircleShape))
                        Spacer(Modifier.weight(1f))
                        Text(
                            when {
                                button != null -> "◀ ▶ choose · OK open · ▲ back"
                                vm.player.paused || vm.player.isBehindLive ->
                                    "OK ${if (vm.player.paused) "play" else "pause"} · ◀ −10 s · +30 s ▶ · ▼ channels, guide"
                                vm.player.canPause -> "OK pause · ◀ channels · ▶ guide · Back menu"
                                else -> "◀ channels · ▶ guide · Back menu"
                            },
                            color = Tv.muted, fontSize = 14.sp,
                        )
                    }
                    if (current != null) {
                        Text(current.title + if (current.subtitle.isNotBlank()) " · ${current.subtitle}" else "",
                            color = Tv.text, fontSize = 22.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                            Text(timeRange(context, current.start, current.stop), color = Tv.muted, fontSize = 16.sp)
                            val progress = ((nowS - current.start).toFloat() / (current.stop - current.start).coerceAtLeast(1)).coerceIn(0f, 1f)
                            Box(Modifier.weight(1f).height(5.dp).background(Color(0x33FFFFFF), RoundedCornerShape(3.dp))) {
                                Box(Modifier.fillMaxHeight().fillMaxWidth(progress).background(Tv.accent, RoundedCornerShape(3.dp)))
                            }
                            Text("${((current.stop - nowS).coerceAtLeast(0) + 59) / 60} min left", color = Tv.muted, fontSize = 16.sp)
                        }
                    } else {
                        Text("No guide information", color = Tv.muted, fontSize = 18.sp)
                    }
                }
            }
            TimeshiftBar(vm, button)
            // Mini guide: what's coming up on this channel, across the whole screen.
            val later = vm.upNext(ch.uuid, 5, nowS)
            if (later.isNotEmpty()) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    later.forEachIndexed { i, p ->
                        Column(
                            Modifier
                                .weight(1f)
                                .background(if (i == 0) Color(0x2EF5B63F) else Color(0x1FFFFFFF), RoundedCornerShape(8.dp))
                                .padding(horizontal = 14.dp, vertical = 10.dp),
                            verticalArrangement = Arrangement.spacedBy(2.dp),
                        ) {
                            Text((if (i == 0) "Next · " else "") + timeOf(context, p.start), color = if (i == 0) Tv.accent else Tv.muted, fontSize = 14.sp)
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                if (p.isScheduled) Box(Modifier.size(8.dp).background(Tv.rec, CircleShape))
                                Text(p.title, color = Tv.text, fontSize = 16.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            }
                        }
                    }
                    // Keep tiles the same width when fewer programmes are known.
                    repeat(5 - later.size) { Spacer(Modifier.weight(1f)) }
                }
            }
        }
    }
}

/** Left panel with every channel and what's on it now. */
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

/**
 * Where you are in Tvheadend's timeshift buffer: LIVE, or paused / behind live with how far, on a
 * bar spanning what can be rewound.
 */
@Composable
private fun TimeshiftBar(vm: AppViewModel, button: Int?) {
    val p = vm.player
    if (!p.canPause) {
        p.pauseUnavailable?.let { Text(it, color = Tv.muted, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis) }
        return
    }
    val behind = p.behindLiveMs
    val span = p.liveBufferMs.coerceAtLeast(1)
    val shifted = p.paused || p.isBehindLive
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        Text(
            when {
                p.paused -> "❚❚  Paused"
                shifted -> "▶  Behind live"
                else -> "●  LIVE"
            },
            color = if (shifted) Tv.accent else Tv.rec, fontSize = 16.sp, fontWeight = FontWeight.SemiBold,
        )
        Box(Modifier.weight(1f).height(5.dp).background(Color(0x33FFFFFF), RoundedCornerShape(3.dp))) {
            val f = (1f - behind.toFloat() / span).coerceIn(0f, 1f)
            Box(Modifier.fillMaxHeight().fillMaxWidth(f).background(if (shifted) Tv.accent else Color(0x66FFFFFF), RoundedCornerShape(3.dp)))
        }
        Text(
            if (shifted) "−" + clock(behind) else "Can rewind ${clock(span)}",
            color = Tv.muted, fontSize = 15.sp,
        )
    }
    // Paused or behind live, the arrows scrub: the channel list, guide and live are buttons here (Down).
    if (shifted) {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            listOf("☰  Channels", "▦  Guide", "●  Live").forEachIndexed { i, label ->
                val sel = button == i
                Text(
                    label, fontSize = 17.sp, fontWeight = if (sel) FontWeight.Bold else FontWeight.Normal,
                    color = if (sel) Color.Black else Tv.text,
                    modifier = Modifier
                        .background(if (sel) Tv.accent else Color(0x26FFFFFF), RoundedCornerShape(18.dp))
                        .padding(horizontal = 18.dp, vertical = 8.dp),
                )
            }
        }
    }
}
