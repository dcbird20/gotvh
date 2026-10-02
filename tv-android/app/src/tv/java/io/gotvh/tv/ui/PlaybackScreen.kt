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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.gotvh.tv.AppViewModel
import kotlinx.coroutines.delay

private const val BACK_MS = 10_000L
private const val FORWARD_MS = 30_000L

/**
 * Watching a recording, with the same playback bar as live TV:
 *  OK/⏯ pause · Left/⏪ back 10 s · Right/⏩ forward 30 s · Down: Guide · Channels · Recordings ·
 *  Search · Restart (the recording keeps playing behind the guide, recordings and search; Back there
 *  comes back here). Back hides the bar, then leaves for Recordings (where you stopped is saved).
 */
@Composable
fun PlaybackScreen(vm: AppViewModel) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val r = vm.playing ?: return
    val exo = vm.player.exo
    val focus = remember { FocusRequester() }
    var position by remember { mutableLongStateOf(0L) }
    var duration by remember { mutableLongStateOf(0L) }
    var paused by remember { mutableStateOf(false) }
    var overlayUntil by remember { mutableLongStateOf(System.currentTimeMillis() + 4000) }
    var clockNow by remember { mutableLongStateOf(System.currentTimeMillis()) }
    /** Selected bar button (0 Guide, 1 Channels, 2 Recordings, 3 Search, 4 Restart), or null. */
    var button by remember { mutableStateOf<Int?>(null) }
    /** The full description and details, over the picture (Up or Info; Up / Back / Info again closes). */
    var info by remember { mutableStateOf(false) }
    val labels = COMMON_BUTTONS + "⏮  Restart"

    fun show() {
        overlayUntil = System.currentTimeMillis() + 5000
        clockNow = System.currentTimeMillis()
    }

    fun seek(delta: Long) {
        val d = exo.duration
        val target = (exo.currentPosition + delta).coerceAtLeast(0)
        exo.seekTo(if (d > 0) target.coerceAtMost(d - 1000) else target)
        position = exo.currentPosition
        show()
    }

    fun togglePause() {
        exo.playWhenReady = !exo.playWhenReady
        paused = !exo.playWhenReady
        if (paused) vm.saveRecordingPosition(force = true)
        show()
    }

    fun act(b: Int) {
        button = null
        vm.saveRecordingPosition(force = true)
        when (b) {
            0 -> { vm.guideRow = vm.currentIndex; vm.screen = io.gotvh.tv.Screen.Guide }
            1 -> { vm.requestChannelList = true; vm.goLive() }
            2 -> vm.open(io.gotvh.tv.Screen.Recordings)
            3 -> vm.open(io.gotvh.tv.Screen.Search)
            else -> { exo.seekTo(0); show() }
        }
    }

    val visible = clockNow < overlayUntil || vm.player.tuning || button != null

    LaunchedEffect(Unit) { focus.requestFocus() }
    LaunchedEffect(vm.menuOpen) { if (!vm.menuOpen) focus.requestFocus() }
    LaunchedEffect(r.uuid) {
        var ticks = 0
        while (true) {
            delay(500)
            position = exo.currentPosition
            duration = exo.duration.coerceAtLeast(0)
            paused = !exo.playWhenReady
            clockNow = System.currentTimeMillis()
            if (++ticks % 20 == 0) vm.saveRecordingPosition()
        }
    }
    LaunchedEffect(visible) { if (!visible) button = null }
    LaunchedEffect(vm.player.ended) { if (vm.player.ended) vm.leavePlayback() }
    // Back: off the buttons, then hide the bar, then leave (never just stops).
    BackHandler {
        when {
            info -> info = false
            button != null -> { button = null; show() }
            visible -> { overlayUntil = 0; clockNow = System.currentTimeMillis() }
            else -> vm.leavePlayback()
        }
    }

    Box(
        Modifier
            .fillMaxSize()
            .focusRequester(focus)
            .focusable()
            .onPreviewKeyEvent { ev ->
                if (isHeldOk(ev)) return@onPreviewKeyEvent true
                if (ev.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                val k = ev.nativeKeyEvent.keyCode
                val ok = k == KeyEvent.KEYCODE_DPAD_CENTER || k == KeyEvent.KEYCODE_ENTER || k == KeyEvent.KEYCODE_NUMPAD_ENTER
                val b = button
                when {
                    k == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE || k == KeyEvent.KEYCODE_SPACE -> togglePause()
                    k == KeyEvent.KEYCODE_MEDIA_PLAY -> { exo.playWhenReady = true; paused = false; show() }
                    k == KeyEvent.KEYCODE_MEDIA_PAUSE -> { exo.playWhenReady = false; paused = true; show() }
                    k == KeyEvent.KEYCODE_MEDIA_REWIND -> seek(-BACK_MS)
                    k == KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> seek(FORWARD_MS)
                    k == KeyEvent.KEYCODE_GUIDE -> act(0)
                    k == KeyEvent.KEYCODE_MENU -> { vm.saveRecordingPosition(force = true); vm.menuOpen = true }
                    // On the bar's buttons.
                    b != null -> when {
                        k == KeyEvent.KEYCODE_DPAD_LEFT -> { button = (b - 1).coerceAtLeast(0); show() }
                        k == KeyEvent.KEYCODE_DPAD_RIGHT -> { button = (b + 1).coerceAtMost(labels.size - 1); show() }
                        k == KeyEvent.KEYCODE_DPAD_UP -> { button = null; show() }
                        ok -> act(b)
                        else -> return@onPreviewKeyEvent false
                    }
                    ok && info -> info = false
                    ok -> togglePause()
                    k == KeyEvent.KEYCODE_DPAD_LEFT -> seek(-BACK_MS)
                    k == KeyEvent.KEYCODE_DPAD_RIGHT -> seek(FORWARD_MS)
                    k == KeyEvent.KEYCODE_DPAD_DOWN -> { button = 0; show() }
                    k == KeyEvent.KEYCODE_DPAD_UP || k == KeyEvent.KEYCODE_INFO -> { info = !info; show() }
                    else -> return@onPreviewKeyEvent false
                }
                true
            },
    ) {
        vm.player.status?.let { msg ->
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text(msg, color = Tv.text, fontSize = 20.sp,
                    modifier = Modifier.background(Tv.panel, RoundedCornerShape(12.dp)).padding(horizontal = 26.dp, vertical = 16.dp))
            }
        }
        if (info) {
            Box(Modifier.fillMaxSize().padding(start = 48.dp, end = 48.dp, top = 36.dp), contentAlignment = Alignment.TopStart) {
                Column(
                    Modifier.fillMaxWidth(0.62f).background(Tv.panel, RoundedCornerShape(14.dp)).padding(24.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(r.title, color = Tv.text, fontSize = 24.sp, fontWeight = FontWeight.Bold)
                    if (r.subtitle.isNotBlank()) Text(r.subtitle, color = Tv.text, fontSize = 18.sp)
                    Text(
                        listOfNotNull("${dayLabel(r.start)} ${timeRange(context, r.start, r.stop)}", r.channelName.ifBlank { null },
                            "${r.durationSec / 60} min", if (vm.player.growing) "● still recording" else null).joinToString("  ·  "),
                        color = Tv.muted, fontSize = 15.sp,
                    )
                    Text(r.description.ifBlank { "No description in the guide." }, color = Tv.text, fontSize = 17.sp, maxLines = 14, overflow = TextOverflow.Ellipsis)
                    Text("▲ / Back / OK closes", color = Tv.muted, fontSize = 13.sp)
                }
            }
        }
        if (!visible && paused) {
            Box(Modifier.fillMaxSize().padding(36.dp), contentAlignment = Alignment.TopStart) {
                Text("❚❚  Paused", color = Tv.accent, fontSize = 20.sp, fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.background(Tv.panel, RoundedCornerShape(10.dp)).padding(horizontal = 16.dp, vertical = 8.dp))
            }
        }
        if (visible) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.BottomCenter) {
                Column(
                    Modifier
                        .fillMaxWidth()
                        .background(Brush.verticalGradient(listOf(Color.Transparent, Color(0xF00B1220))))
                        .padding(start = 48.dp, end = 48.dp, top = 60.dp, bottom = 36.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                        Text(if (paused) "❚❚" else "▶", color = Tv.accent, fontSize = 24.sp)
                        Text(r.title, color = Tv.text, fontSize = 24.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (r.subtitle.isNotBlank()) Text(r.subtitle, color = Tv.muted, fontSize = 18.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (vm.player.growing) Text("● Still recording", color = Tv.rec, fontSize = 16.sp)
                        Spacer(Modifier.weight(1f))
                        Text(
                            if (button != null) "◀ ▶ choose · OK open · ▲ back" else "OK ${if (paused) "play" else "pause"} · ◀ −10 s · +30 s ▶ · ▼ buttons · ▲ info",
                            color = Tv.muted, fontSize = 14.sp,
                        )
                    }
                    if (r.description.isNotBlank() && !info) {
                        Text(r.description, color = Tv.muted, fontSize = 15.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                    val f = if (duration > 0) (position.toFloat() / duration).coerceIn(0f, 1f) else 0f
                    Box(Modifier.fillMaxWidth().height(6.dp).background(Color(0x33FFFFFF), RoundedCornerShape(3.dp))) {
                        Box(Modifier.fillMaxHeight().fillMaxWidth(f).background(Tv.accent, RoundedCornerShape(3.dp)))
                    }
                    Row {
                        Text(clock(position), color = Tv.muted, fontSize = 15.sp)
                        Spacer(Modifier.weight(1f))
                        Text(if (duration > 0) "-" + clock(duration - position) else if (vm.player.tuning) "Loading…" else "", color = Tv.muted, fontSize = 15.sp)
                    }
                    BarButtons(labels, button)
                }
            }
        }
    }
}
