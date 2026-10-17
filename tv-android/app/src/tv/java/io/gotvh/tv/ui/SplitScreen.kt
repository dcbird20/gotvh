package io.gotvh.tv.ui

import android.view.KeyEvent
import android.view.SurfaceView
import android.view.ViewGroup
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
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.ui.PlayerView
import io.gotvh.tv.AppViewModel
import io.gotvh.tv.AppViewModel.SplitLayout
import io.gotvh.tv.Screen
import io.gotvh.tv.nowSec
import io.gotvh.tv.player.TvPlayer
import kotlinx.coroutines.delay

private const val LABEL_MS = 5000L
private const val PAGE = 8

/**
 * Split screen: two live channels at once, side by side or one big with a small picture in the
 * corner. The highlighted picture is the one you hear.
 *  ◀ ▶ pick a picture · ▲ ▼ (or Ch±, digits) change its channel · ⏯ pause it · OK options
 *  (channel list, swap, layout, full screen) · Back: the highlighted picture full screen.
 */
@Composable
fun SplitScreen(vm: AppViewModel) {
    val root = remember { FocusRequester() }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    var lastKey by remember { mutableLongStateOf(System.currentTimeMillis()) }
    var menuOpen by remember { mutableStateOf(false) }
    var menuIndex by remember { mutableIntStateOf(0) }
    var listOpen by remember { mutableStateOf(false) }
    var listIndex by remember { mutableIntStateOf(0) }
    var digits by remember { mutableStateOf("") }
    val channels = vm.channels
    val active = vm.splitActive
    val sideBySide = vm.splitLayout == SplitLayout.SideBySide
    // Screen position of each picture: first = left / big, second = right / small.
    val first = if (vm.splitSwapped) 1 else 0
    val second = 1 - first

    fun openList() {
        menuOpen = false
        val ch = vm.splitChannelOf(active)
        listIndex = channels.indexOfFirst { it.uuid == ch?.uuid }.coerceAtLeast(0)
        listOpen = true
    }
    val actions: List<Pair<String, () -> Unit>> = listOf(
        "☰  Change channel" to { openList() },
        "⇄  Swap" to { menuOpen = false; vm.swapSplit() },
        (if (sideBySide) "▣  Picture in picture" else "◫  Side by side") to { menuOpen = false; vm.toggleSplitLayout() },
        "⛶  Full screen" to { menuOpen = false; vm.closeSplit(active) },
        (if (vm.player.captions) "CC  On" else "CC  Off") to { toggleCaptions(vm) },
        "Close" to { menuOpen = false },
    )

    LaunchedEffect(Unit) {
        runCatching { root.requestFocus() }
        while (true) {
            delay(500)
            now = System.currentTimeMillis()
        }
    }
    LaunchedEffect(vm.menuOpen) { if (!vm.menuOpen) runCatching { root.requestFocus() } }
    LaunchedEffect(digits) {
        if (digits.isEmpty()) return@LaunchedEffect
        delay(1500)
        val i = vm.indexForNumber(digits)
        if (i >= 0) vm.tuneSplit(active, channels[i]) else vm.notice = "No channel $digits"
        digits = ""
    }

    BackHandler(enabled = !vm.menuOpen) {
        when {
            listOpen -> listOpen = false
            menuOpen -> menuOpen = false
            else -> vm.closeSplit(active)
        }
    }

    Box(
        Modifier
            .fillMaxSize()
            .background(Color.Black)
            .onPreviewKeyEvent { ev ->
                if (isHeldOk(ev)) return@onPreviewKeyEvent true
                if (ev.type != KeyEventType.KeyDown || channels.isEmpty()) return@onPreviewKeyEvent false
                lastKey = System.currentTimeMillis()
                val k = ev.nativeKeyEvent.keyCode
                if (k in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9) {
                    digits += (k - KeyEvent.KEYCODE_0).toString()
                    return@onPreviewKeyEvent true
                }
                when (k) {
                    KeyEvent.KEYCODE_MENU -> { vm.menuOpen = true; return@onPreviewKeyEvent true }
                    KeyEvent.KEYCODE_GUIDE -> { vm.open(Screen.Guide); return@onPreviewKeyEvent true }
                    KeyEvent.KEYCODE_CAPTIONS -> { toggleCaptions(vm); return@onPreviewKeyEvent true }
                    KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_SPACE -> { vm.splitPlayer(active).togglePause(); return@onPreviewKeyEvent true }
                }
                when {
                    listOpen -> when (k) {
                        KeyEvent.KEYCODE_DPAD_UP -> listIndex = Math.floorMod(listIndex - 1, channels.size)
                        KeyEvent.KEYCODE_DPAD_DOWN -> listIndex = Math.floorMod(listIndex + 1, channels.size)
                        KeyEvent.KEYCODE_CHANNEL_UP, KeyEvent.KEYCODE_PAGE_UP -> listIndex = (listIndex - PAGE).coerceAtLeast(0)
                        KeyEvent.KEYCODE_CHANNEL_DOWN, KeyEvent.KEYCODE_PAGE_DOWN -> listIndex = (listIndex + PAGE).coerceAtMost(channels.size - 1)
                        KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> {
                            vm.tuneSplit(active, channels[listIndex])
                            listOpen = false
                        }
                        else -> {}
                    }
                    menuOpen -> when (k) {
                        KeyEvent.KEYCODE_DPAD_LEFT -> menuIndex = Math.floorMod(menuIndex - 1, actions.size)
                        KeyEvent.KEYCODE_DPAD_RIGHT -> menuIndex = Math.floorMod(menuIndex + 1, actions.size)
                        KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> actions[menuIndex].second()
                        KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN -> menuOpen = false
                        else -> {}
                    }
                    else -> when (k) {
                        // Side by side: Left / Right pick that picture. Picture in picture: either one moves between them.
                        KeyEvent.KEYCODE_DPAD_LEFT -> vm.focusSplit(if (sideBySide) first else 1 - active)
                        KeyEvent.KEYCODE_DPAD_RIGHT -> vm.focusSplit(if (sideBySide) second else 1 - active)
                        KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_CHANNEL_UP -> vm.stepSplit(active, +1)
                        KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_CHANNEL_DOWN -> vm.stepSplit(active, -1)
                        KeyEvent.KEYCODE_LAST_CHANNEL -> vm.swapSplit()
                        KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER, KeyEvent.KEYCODE_INFO -> {
                            menuIndex = 0
                            menuOpen = true
                        }
                        else -> return@onPreviewKeyEvent false
                    }
                }
                true
            }
            .focusRequester(root)
            .focusable(),
    ) {
        val showLabels = sideBySide || now - lastKey < LABEL_MS || menuOpen || listOpen
        if (sideBySide) {
            Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 24.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    for (i in listOf(first, second)) {
                        key(i, false) {
                            Pane(vm, i, Modifier.weight(1f).aspectRatio(16f / 9f), small = false, label = true)
                        }
                    }
                }
                Spacer(Modifier.height(18.dp))
                if (!menuOpen && !listOpen) {
                    Text("◀ ▶ pick a picture (its sound plays)  ·  ▲ ▼ change its channel  ·  OK options  ·  Back full screen",
                        color = Tv.muted, fontSize = 14.sp, modifier = Modifier.align(Alignment.CenterHorizontally))
                }
            }
        } else {
            BoxWithConstraints(Modifier.fillMaxSize()) {
                key(first, false) { Pane(vm, first, Modifier.fillMaxSize(), small = false, label = showLabels) }
                key(second, true) {
                    Pane(
                        vm, second,
                        Modifier.align(Alignment.TopEnd).padding(top = 32.dp, end = 32.dp).width(maxWidth * 0.32f).aspectRatio(16f / 9f),
                        small = true, label = true,
                    )
                }
            }
        }

        if (digits.isNotEmpty()) {
            Box(Modifier.fillMaxSize().padding(36.dp), contentAlignment = Alignment.TopCenter) {
                Text(digits, color = Tv.accent, fontSize = 48.sp, fontWeight = FontWeight.Bold,
                    modifier = Modifier.background(Tv.panel, RoundedCornerShape(12.dp)).padding(horizontal = 22.dp, vertical = 4.dp))
            }
        }
        if (menuOpen) {
            Box(Modifier.fillMaxSize().padding(bottom = 40.dp), contentAlignment = Alignment.BottomCenter) {
                Row(
                    Modifier.background(Tv.panel, RoundedCornerShape(14.dp)).padding(10.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    actions.forEachIndexed { i, (label, _) ->
                        val sel = i == menuIndex
                        Text(label, color = if (sel) Color.Black else Tv.text, fontSize = 17.sp,
                            fontWeight = if (sel) FontWeight.SemiBold else FontWeight.Normal,
                            modifier = Modifier.background(if (sel) Tv.accent else Color(0x22FFFFFF), RoundedCornerShape(10.dp))
                                .padding(horizontal = 16.dp, vertical = 10.dp))
                    }
                }
            }
        }
        if (listOpen) {
            // The list opens on the side of the highlighted picture (side by side), else on the left.
            val onRight = sideBySide && active == second
            Box(Modifier.fillMaxSize(), contentAlignment = if (onRight) Alignment.CenterEnd else Alignment.CenterStart) {
                SplitChannelList(vm, listIndex)
            }
        }
    }
}

private fun toggleCaptions(vm: AppViewModel) {
    vm.toggleCaptions()
    vm.player2.showCaptions(vm.player.captions)
    vm.notice = if (vm.player.captions) "Captions on" else "Captions off"
}

/** One picture: the video, a highlight when it's the one you hear, and what's on. */
@Composable
private fun Pane(vm: AppViewModel, i: Int, modifier: Modifier, small: Boolean, label: Boolean) {
    val player = vm.splitPlayer(i)
    val ch = vm.splitChannelOf(i)
    val isActive = vm.splitActive == i
    Box(
        modifier
            .background(Color.Black, RoundedCornerShape(if (small) 10.dp else 6.dp))
            .border(if (isActive) 4.dp else 1.dp, if (isActive) Tv.accent else Color(0x33FFFFFF), RoundedCornerShape(if (small) 10.dp else 6.dp))
            .padding(if (isActive) 4.dp else 1.dp),
    ) {
        PaneVideo(player, overlay = small)
        val message = player.status ?: if (player.tuning) "Tuning…" else null
        if (message != null) {
            Box(Modifier.fillMaxSize().padding(12.dp), contentAlignment = Alignment.Center) {
                Text(message, color = Tv.text, fontSize = if (small) 13.sp else 17.sp,
                    modifier = Modifier.background(Tv.panel, RoundedCornerShape(10.dp)).padding(horizontal = 14.dp, vertical = 8.dp))
            }
        }
        if (player.paused) {
            Text("❚❚", color = Tv.accent, fontSize = 22.sp, fontWeight = FontWeight.Bold,
                modifier = Modifier.align(Alignment.TopStart).padding(10.dp).background(Tv.panel, RoundedCornerShape(8.dp)).padding(horizontal = 10.dp, vertical = 4.dp))
        }
        if (label && ch != null) {
            val on = vm.nowAndNext(ch.uuid, nowSec()).first
            Row(
                Modifier.align(Alignment.BottomStart).fillMaxWidth()
                    .background(Color(0xCC0B1220))
                    .padding(horizontal = 12.dp, vertical = if (small) 5.dp else 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                if (!small) ChannelLogo(ch, vm.imageLoader, 30.dp)
                Column(Modifier.weight(1f)) {
                    Text(listOf(ch.number, ch.name).filter { it.isNotBlank() }.joinToString("  "),
                        color = if (isActive) Tv.accent else Tv.text, fontSize = if (small) 13.sp else 16.sp,
                        fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (on != null) Text(on.title, color = Tv.muted, fontSize = if (small) 11.sp else 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                Text(if (isActive) "🔊" else "🔇", fontSize = if (small) 13.sp else 16.sp)
            }
        }
    }
}

/** The player's picture. The small corner picture is drawn over the big one ([overlay]). */
@Composable
private fun PaneVideo(player: TvPlayer, overlay: Boolean) {
    AndroidView(
        factory = { ctx ->
            PlayerView(ctx).apply {
                useController = false
                isFocusable = false
                descendantFocusability = ViewGroup.FOCUS_BLOCK_DESCENDANTS
                setShutterBackgroundColor(android.graphics.Color.BLACK)
                keepScreenOn = true
                (videoSurfaceView as? SurfaceView)?.setZOrderMediaOverlay(overlay)
                this.player = player.exo
            }
        },
        // Hand the picture back cleanly (the player only lets go of this view's surface).
        onRelease = { it.player = null },
        modifier = Modifier.fillMaxSize(),
    )
}

/** Every channel with what's on now, for the highlighted picture. */
@Composable
private fun SplitChannelList(vm: AppViewModel, selected: Int) {
    val state = rememberLazyListState()
    LaunchedEffect(selected) { state.scrollToItem((selected - 4).coerceAtLeast(0)) }
    val nowS = nowSec()
    Column(Modifier.fillMaxHeight().width(480.dp).background(Tv.panelSolid).padding(vertical = 20.dp)) {
        Text("Channel for the highlighted picture", color = Tv.muted, fontSize = 15.sp, modifier = Modifier.padding(horizontal = 24.dp, vertical = 6.dp))
        LazyColumn(state = state) {
            itemsIndexed(vm.channels, key = { _, c -> c.uuid }) { i, ch ->
                val sel = i == selected
                val on = vm.nowAndNext(ch.uuid, nowS).first
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 2.dp)
                        .background(if (sel) Tv.accent else Color.Transparent, RoundedCornerShape(8.dp))
                        .padding(horizontal = 12.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Text(ch.number, color = if (sel) Color.Black else Tv.accent, fontSize = 16.sp, fontWeight = FontWeight.Bold, modifier = Modifier.width(48.dp))
                    ChannelLogo(ch, vm.imageLoader, 30.dp)
                    Column(Modifier.weight(1f)) {
                        Text(ch.name, color = if (sel) Color.Black else Tv.text, fontSize = 16.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(on?.title ?: "No guide information", color = if (sel) Color(0xCC000000) else Tv.muted, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
    }
}
