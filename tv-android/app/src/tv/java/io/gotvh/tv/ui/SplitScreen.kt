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
 * Split screen: live channels at once — two side by side, one big with a small picture in a corner
 * (which can move), or four in a grid. The highlighted picture is the one you hear.
 *  Two pictures: ◀ ▶ pick a picture · ▲ ▼ change its channel. Grid: the arrows move between the four,
 *  Ch± changes the channel. Digits tune the highlighted picture · ⏯ pauses it · OK options
 *  (channel list, swap, layouts, move the small picture, full screen, captions) · Back: the
 *  highlighted picture full screen.
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
    /** Moving the small picture: the arrows send it to that corner, OK or Back when done. */
    var moving by remember { mutableStateOf(false) }
    val channels = vm.channels
    val active = vm.splitActive
    val sideBySide = vm.splitLayout == SplitLayout.SideBySide
    val grid = vm.splitLayout == SplitLayout.Grid
    val pip = vm.splitLayout == SplitLayout.PictureInPicture
    // Screen position of each picture: first = left / big, second = right / small.
    val first = if (vm.splitSwapped) 1 else 0
    val second = 1 - first

    fun openList() {
        menuOpen = false
        val ch = vm.splitChannelOf(active)
        listIndex = channels.indexOfFirst { it.uuid == ch?.uuid }.coerceAtLeast(0)
        listOpen = true
    }
    val actions: List<Pair<String, () -> Unit>> = buildList {
        add("☰  Change channel" to { openList() })
        if (!grid) add("⇄  Swap" to { menuOpen = false; vm.swapSplit() })
        if (pip) add("✥  Move small picture" to { menuOpen = false; moving = true })
        if (!sideBySide) add("◫  Side by side" to { menuOpen = false; vm.chooseSplitLayout(SplitLayout.SideBySide) })
        if (!pip) add("▣  Picture in picture" to { menuOpen = false; vm.chooseSplitLayout(SplitLayout.PictureInPicture) })
        if (!grid) add("⊞  Four pictures" to { menuOpen = false; vm.chooseSplitLayout(SplitLayout.Grid) })
        add("⛶  Full screen" to { menuOpen = false; vm.closeSplit(active) })
        add((if (vm.player.captions) "CC  On" else "CC  Off") to { toggleCaptions(vm) })
        add("Close" to { menuOpen = false })
    }

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
            moving -> moving = false
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
                    // Corners: 0 top right, 1 bottom right, 2 bottom left, 3 top left.
                    moving -> {
                        val right = vm.pipCorner <= 1
                        val top = vm.pipCorner == 0 || vm.pipCorner == 3
                        when (k) {
                            KeyEvent.KEYCODE_DPAD_UP -> vm.placePip(if (right) 0 else 3)
                            KeyEvent.KEYCODE_DPAD_DOWN -> vm.placePip(if (right) 1 else 2)
                            KeyEvent.KEYCODE_DPAD_LEFT -> vm.placePip(if (top) 3 else 2)
                            KeyEvent.KEYCODE_DPAD_RIGHT -> vm.placePip(if (top) 0 else 1)
                            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> moving = false
                            else -> {}
                        }
                    }
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
                        KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> actions.getOrNull(menuIndex)?.second?.invoke()
                        KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN -> menuOpen = false
                        else -> {}
                    }
                    // Grid: the arrows move between the four pictures (0 1 / 2 3); Ch± changes the channel.
                    grid -> when (k) {
                        KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT -> vm.focusSplit(active xor 1)
                        KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN -> vm.focusSplit(active xor 2)
                        KeyEvent.KEYCODE_CHANNEL_UP -> vm.stepSplit(active, +1)
                        KeyEvent.KEYCODE_CHANNEL_DOWN -> vm.stepSplit(active, -1)
                        KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER, KeyEvent.KEYCODE_INFO -> {
                            menuIndex = 0
                            menuOpen = true
                        }
                        else -> return@onPreviewKeyEvent false
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
        val showLabels = sideBySide || grid || now - lastKey < LABEL_MS || menuOpen || listOpen
        if (grid) {
            Column(Modifier.fillMaxSize().padding(10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                for (row in 0..1) {
                    Row(Modifier.weight(1f).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        for (col in 0..1) {
                            val i = row * 2 + col
                            key(i, false) { Pane(vm, i, Modifier.weight(1f).fillMaxHeight(), small = true, label = true, overlay = false) }
                        }
                    }
                }
            }
        } else if (sideBySide) {
            Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 24.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    for (i in listOf(first, second)) {
                        key(i, false) {
                            Pane(vm, i, Modifier.weight(1f).aspectRatio(16f / 9f), small = false, label = true, overlay = false)
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
                key(first, false) { Pane(vm, first, Modifier.fillMaxSize(), small = false, label = showLabels, overlay = false) }
                // The small picture's corner (moves with "Move small picture"); its label stays clear of the edge.
                val corner = when (vm.pipCorner) {
                    1 -> Alignment.BottomEnd
                    2 -> Alignment.BottomStart
                    3 -> Alignment.TopStart
                    else -> Alignment.TopEnd
                }
                key(second, true) {
                    Pane(
                        vm, second,
                        Modifier.align(corner).padding(32.dp).width(maxWidth * 0.32f).aspectRatio(16f / 9f),
                        small = true, label = true, overlay = true,
                    )
                }
            }
        }

        if (moving) {
            Box(Modifier.fillMaxSize().padding(36.dp), contentAlignment = Alignment.Center) {
                Text("▲ ▼ ◀ ▶ move the small picture to a corner  ·  OK done",
                    color = Tv.text, fontSize = 18.sp,
                    modifier = Modifier.background(Tv.panel, RoundedCornerShape(12.dp)).padding(horizontal = 22.dp, vertical = 12.dp))
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
            val onRight = (sideBySide && active == second) || (grid && active % 2 == 1)
            Box(Modifier.fillMaxSize(), contentAlignment = if (onRight) Alignment.CenterEnd else Alignment.CenterStart) {
                SplitChannelList(vm, listIndex)
            }
        }
    }
}

private fun toggleCaptions(vm: AppViewModel) {
    vm.toggleCaptions()
    vm.splitExtras().forEach { it.showCaptions(vm.player.captions) }
    vm.notice = if (vm.player.captions) "Captions on" else "Captions off"
}

/** One picture: the video, a highlight when it's the one you hear, and what's on. */
@Composable
private fun Pane(vm: AppViewModel, i: Int, modifier: Modifier, small: Boolean, label: Boolean, overlay: Boolean) {
    val player = vm.splitPlayer(i)
    val ch = vm.splitChannelOf(i)
    val isActive = vm.splitActive == i
    Box(
        modifier
            .background(Color.Black, RoundedCornerShape(if (small) 10.dp else 6.dp))
            .border(if (isActive) 4.dp else 1.dp, if (isActive) Tv.accent else Color(0x33FFFFFF), RoundedCornerShape(if (small) 10.dp else 6.dp))
            .padding(if (isActive) 4.dp else 1.dp),
    ) {
        PaneVideo(player, overlay = overlay)
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
