package io.gotvh.tv.ui

import android.view.KeyEvent
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
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
import kotlinx.coroutines.delay

private const val BACK_MS = 10_000L
private const val FORWARD_MS = 30_000L
private const val CONTROLS_IDLE_MS = 8000L

/**
 * A recording, with the same controls as live TV. With nothing on screen:
 *  OK (or Up / Down) the controls · Left / Right back 10 s / forward 30 s · Back to Recordings
 *  (where you stopped is saved).
 * The controls: progress row (Left/Right move) · ⏯ · Info · Guide · Channels · Recordings ·
 *  Search · Restart. The recording keeps playing behind the guide, recordings and search, and Back
 *  there comes back here.
 */
@Composable
fun PlaybackScreen(vm: AppViewModel) {
    val context = LocalContext.current
    val r = vm.playing ?: return
    val exo = vm.player.exo
    val root = remember { FocusRequester() }
    var position by remember { mutableLongStateOf(0L) }
    var duration by remember { mutableLongStateOf(0L) }
    var paused by remember { mutableStateOf(false) }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    var lastKey by remember { mutableLongStateOf(System.currentTimeMillis()) }
    var flashUntil by remember { mutableLongStateOf(System.currentTimeMillis() + 3000) }
    var controls by remember { mutableStateOf(false) }
    var info by remember { mutableStateOf(false) }
    val trick = remember { TrickKeys() }

    fun flash() {
        now = System.currentTimeMillis()
        flashUntil = now + 3000
    }
    fun seek(delta: Long) {
        val d = exo.duration
        val target = (exo.currentPosition + delta).coerceAtLeast(0)
        exo.seekTo(if (d > 0) target.coerceAtMost(d - 1000) else target)
        position = exo.currentPosition
        flash()
    }
    fun togglePause() {
        exo.playWhenReady = !exo.playWhenReady
        paused = !exo.playWhenReady
        if (paused) vm.saveRecordingPosition(force = true)
    }
    fun leaveFor(target: Screen) {
        controls = false
        vm.saveRecordingPosition(force = true)
        if (target == Screen.Guide) {
            vm.guideRow = vm.currentIndex
            vm.screen = Screen.Guide
        } else {
            vm.open(target)
        }
    }

    LaunchedEffect(r.uuid) {
        var ticks = 0
        while (true) {
            delay(500)
            position = exo.currentPosition
            duration = exo.duration.coerceAtLeast(0)
            paused = !exo.playWhenReady
            now = System.currentTimeMillis()
            if (controls && !info && now - lastKey > CONTROLS_IDLE_MS) controls = false
            if (++ticks % 20 == 0) vm.saveRecordingPosition()
        }
    }
    LaunchedEffect(controls, info, vm.menuOpen) { if (!controls && !info && !vm.menuOpen) runCatching { root.requestFocus() } }
    LaunchedEffect(vm.player.ended) { if (vm.player.ended) vm.leavePlayback() }
    // Back: close the controls first; with nothing on screen, back to Recordings (place saved).
    BackHandler(enabled = !info) { if (controls) controls = false else vm.leavePlayback() }
    // Fast-forwarding: Back returns to where it started (registered last, so it comes first).
    BackHandler(enabled = vm.player.trickSpeed != 0) { vm.player.trickCancel(); flash() }

    Box(
        Modifier
            .fillMaxSize()
            .onPreviewKeyEvent { ev ->
                if (ev.type == KeyEventType.KeyDown) lastKey = System.currentTimeMillis()
                if (info) return@onPreviewKeyEvent false
                // Nothing on screen: Left/Right tap to skip, hold to fast-forward / rewind.
                if (!controls && trick.handle(ev, vm.player) { forward -> seek(if (forward) FORWARD_MS else -BACK_MS) }) {
                    flash()
                    return@onPreviewKeyEvent true
                }
                if (isHeldOk(ev)) return@onPreviewKeyEvent true
                if (ev.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                val k = ev.nativeKeyEvent.keyCode
                when (k) {
                    KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_SPACE -> { togglePause(); flash(); return@onPreviewKeyEvent true }
                    KeyEvent.KEYCODE_MEDIA_PLAY -> { exo.playWhenReady = true; paused = false; flash(); return@onPreviewKeyEvent true }
                    KeyEvent.KEYCODE_MEDIA_PAUSE -> { exo.playWhenReady = false; paused = true; flash(); return@onPreviewKeyEvent true }
                    KeyEvent.KEYCODE_MEDIA_REWIND -> { seek(-BACK_MS); return@onPreviewKeyEvent true }
                    KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> { seek(FORWARD_MS); return@onPreviewKeyEvent true }
                    KeyEvent.KEYCODE_GUIDE -> { leaveFor(Screen.Guide); return@onPreviewKeyEvent true }
                    KeyEvent.KEYCODE_CAPTIONS -> { vm.toggleCaptions(); vm.notice = if (vm.player.captions) "Captions on" else "Captions off"; return@onPreviewKeyEvent true }
                    KeyEvent.KEYCODE_MENU -> { vm.saveRecordingPosition(force = true); vm.menuOpen = true; return@onPreviewKeyEvent true }
                }
                if (controls) return@onPreviewKeyEvent false // real focus inside the controls
                // Nothing on screen: always the same.
                when (k) {
                    KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER,
                    KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_INFO -> controls = true
                    KeyEvent.KEYCODE_DPAD_LEFT -> seek(-BACK_MS)
                    KeyEvent.KEYCODE_DPAD_RIGHT -> seek(FORWARD_MS)
                    else -> return@onPreviewKeyEvent false
                }
                true
            }
            .focusRequester(root)
            .focusable(),
    ) {
        vm.player.status?.let { msg ->
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text(msg, color = Tv.text, fontSize = 20.sp,
                    modifier = Modifier.background(Tv.panel, RoundedCornerShape(12.dp)).padding(horizontal = 26.dp, vertical = 16.dp))
            }
        }
        val fraction = if (duration > 0) position.toFloat() / duration else 0f
        val remaining = if (duration > 0) "−" + clock(duration - position) else if (vm.player.tuning) "Loading…" else ""
        val trickSpeed = vm.player.trickSpeed
        when {
            trickSpeed != 0 -> {
                val at = vm.player.trickPositionMs
                val f = if (duration > 0) at.toFloat() / duration else 0f
                TrickBadge(trickSpeed)
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.BottomCenter) {
                    androidx.compose.foundation.layout.Column(
                        Modifier.padding(start = 48.dp, end = 48.dp, bottom = 36.dp)
                            .background(Tv.panel, RoundedCornerShape(12.dp)).padding(horizontal = 20.dp, vertical = 14.dp),
                    ) {
                        Text(r.title, color = Tv.text, fontSize = 18.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        ProgressLine(f, clock(at), if (duration > 0) "−" + clock((duration - at).coerceAtLeast(0)) else "")
                    }
                }
            }
            controls -> PlayerControls(
                header = { RecordingHeader(vm, paused) },
                progress = { focused -> ProgressLine(fraction, clock(position), remaining, hint = if (focused) "◀ −10 s   ·   +30 s ▶" else null) },
                onScrub = { forward -> seek(if (forward) FORWARD_MS else -BACK_MS) },
                buttons = listOf(
                    (if (paused) "▶  Play" else "❚❚  Pause") to { togglePause() },
                    "ⓘ  Info" to { controls = false; info = true },
                    (if (vm.player.captions) "CC  On" else "CC  Off") to { vm.toggleCaptions() },
                    "▦  Guide" to { leaveFor(Screen.Guide) },
                    "☰  Channels" to { controls = false; vm.saveRecordingPosition(force = true); vm.requestChannelList = true; vm.goLive() },
                    "Recordings" to { leaveFor(Screen.Recordings) },
                    "⌕  Search" to { leaveFor(Screen.Search) },
                    "⏮  Restart" to { exo.seekTo(0) },
                ),
            )
            now < flashUntil || vm.player.tuning -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.BottomCenter) {
                // After skipping: just where you are.
                androidx.compose.foundation.layout.Column(
                    Modifier.padding(start = 48.dp, end = 48.dp, bottom = 36.dp)
                        .background(Tv.panel, RoundedCornerShape(12.dp)).padding(horizontal = 20.dp, vertical = 14.dp),
                ) {
                    Text(r.title, color = Tv.text, fontSize = 18.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    ProgressLine(fraction, clock(position), remaining)
                }
            }
            paused -> Box(Modifier.fillMaxSize().padding(36.dp), contentAlignment = Alignment.TopStart) {
                Text("❚❚  Paused", color = Tv.accent, fontSize = 20.sp, fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.background(Tv.panel, RoundedCornerShape(10.dp)).padding(horizontal = 16.dp, vertical = 8.dp))
            }
        }
        if (info) {
            DetailsCard(
                title = r.title,
                subtitle = r.subtitle,
                meta = listOfNotNull("${dayLabel(r.start)} ${timeRange(context, r.start, r.stop)}", r.channelName.ifBlank { null },
                    "${r.durationSec / 60} min").joinToString("  ·  "),
                status = if (vm.player.growing) "● Still recording" else null,
                description = r.description.ifBlank { "No description in the guide." },
                actions = listOf("Close" to { info = false }),
                onClose = { info = false },
            )
        }
    }
}

@Composable
private fun RecordingHeader(vm: AppViewModel, paused: Boolean) {
    val r = vm.playing ?: return
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        Text(if (paused) "❚❚" else "▶", color = Tv.accent, fontSize = 24.sp)
        Text(r.title, color = Tv.text, fontSize = 24.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (r.subtitle.isNotBlank()) Text(r.subtitle, color = Tv.muted, fontSize = 18.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (vm.player.growing) Text("● Still recording", color = Tv.rec, fontSize = 16.sp)
    }
    if (r.description.isNotBlank()) Text(r.description, color = Tv.muted, fontSize = 15.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
}
