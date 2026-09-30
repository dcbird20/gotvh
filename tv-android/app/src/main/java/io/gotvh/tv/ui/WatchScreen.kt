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

/**
 * Full-screen TV. Keys:
 *  Up / Ch+ next channel · Down / Ch− previous · OK info banner (OK again: channel list) ·
 *  Left channel list · Right / Guide the guide · Menu the menu · digits jump to a number · Last channel ·
 *  Back closes what's open, then opens the menu (Recordings, Settings, Exit…).
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
    val bannerVisible = now < bannerUntil
    val channels = vm.channels

    fun showBanner() {
        now = System.currentTimeMillis()
        bannerUntil = now + BANNER_MS
    }

    fun openList() {
        listIndex = vm.currentIndex
        listOpen = true
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
            bannerVisible -> bannerUntil = 0
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
                        KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.KEYCODE_GUIDE -> {
                            vm.guideRow = listIndex
                            vm.screen = Screen.Guide
                        }
                        else -> return@onPreviewKeyEvent false
                    }
                    return@onPreviewKeyEvent true
                }
                when (k) {
                    KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_CHANNEL_UP -> vm.tune(vm.currentIndex + 1)
                    KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_CHANNEL_DOWN -> vm.tune(vm.currentIndex - 1)
                    KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER ->
                        if (bannerVisible) openList() else showBanner()
                    KeyEvent.KEYCODE_DPAD_LEFT -> openList()
                    KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.KEYCODE_GUIDE -> {
                        vm.guideRow = vm.currentIndex
                        vm.screen = Screen.Guide
                    }
                    KeyEvent.KEYCODE_MENU -> vm.menuOpen = true
                    KeyEvent.KEYCODE_INFO -> showBanner()
                    KeyEvent.KEYCODE_LAST_CHANNEL -> vm.tunePrevious()
                    in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9 -> {
                        digits += (k - KeyEvent.KEYCODE_0).toString()
                        showBanner()
                    }
                    else -> return@onPreviewKeyEvent false
                }
                true
            },
    ) {
        val player = vm.player
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

        if (bannerVisible && !listOpen) ChannelBanner(vm)
        if (listOpen) ChannelList(vm, listIndex)
    }
}

/** Bottom banner: channel, what's on now with progress, and what's next. */
@Composable
private fun ChannelBanner(vm: AppViewModel) {
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
                        Text("OK  channels · ▶  guide · Back  menu", color = Tv.muted, fontSize = 14.sp)
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
