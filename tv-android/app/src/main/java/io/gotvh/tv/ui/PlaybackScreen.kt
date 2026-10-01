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
 * Watching a recording. Left/⏪ back 10 s · Right/⏩ forward 30 s · OK/⏯ pause · Back to Recordings.
 * The position is saved as you go, so it resumes next time.
 */
@Composable
fun PlaybackScreen(vm: AppViewModel) {
    val r = vm.playing ?: return
    val exo = vm.player.exo
    val focus = remember { FocusRequester() }
    var position by remember { mutableLongStateOf(0L) }
    var duration by remember { mutableLongStateOf(0L) }
    var paused by remember { mutableStateOf(false) }
    var overlayUntil by remember { mutableLongStateOf(System.currentTimeMillis() + 4000) }
    var clockNow by remember { mutableLongStateOf(System.currentTimeMillis()) }

    fun show() {
        overlayUntil = System.currentTimeMillis() + 4000
        clockNow = System.currentTimeMillis()
    }

    fun seek(delta: Long) {
        val d = exo.duration
        val target = (exo.currentPosition + delta).coerceAtLeast(0)
        exo.seekTo(if (d > 0) target.coerceAtMost(d - 1000) else target)
        position = exo.currentPosition
        show()
    }

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
    LaunchedEffect(vm.player.ended) { if (vm.player.ended) vm.leavePlayback() }
    BackHandler { vm.leavePlayback() }

    Box(
        Modifier
            .fillMaxSize()
            .focusRequester(focus)
            .focusable()
            .onPreviewKeyEvent { ev ->
                if (isHeldOk(ev)) return@onPreviewKeyEvent true
                if (ev.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                when (ev.nativeKeyEvent.keyCode) {
                    KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_MEDIA_REWIND -> seek(-BACK_MS)
                    KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> seek(FORWARD_MS)
                    KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER,
                    KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_SPACE -> {
                        exo.playWhenReady = !exo.playWhenReady
                        paused = !exo.playWhenReady
                        if (paused) vm.saveRecordingPosition(force = true)
                        show()
                    }
                    KeyEvent.KEYCODE_MEDIA_PLAY -> { exo.playWhenReady = true; paused = false; show() }
                    KeyEvent.KEYCODE_MEDIA_PAUSE -> { exo.playWhenReady = false; paused = true; show() }
                    KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_INFO -> show()
                    KeyEvent.KEYCODE_MENU -> { vm.saveRecordingPosition(force = true); vm.menuOpen = true }
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
        if (paused || clockNow < overlayUntil || vm.player.tuning) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.BottomCenter) {
                Column(
                    Modifier
                        .fillMaxWidth()
                        .background(Brush.verticalGradient(listOf(Color.Transparent, Color(0xF00B1220))))
                        .padding(start = 48.dp, end = 48.dp, top = 60.dp, bottom = 36.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                        Text(if (paused) "❚❚" else "▶", color = Tv.accent, fontSize = 24.sp)
                        Text(r.title, color = Tv.text, fontSize = 24.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (r.subtitle.isNotBlank()) Text(r.subtitle, color = Tv.muted, fontSize = 18.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (vm.player.growing) Text("● Still recording", color = Tv.rec, fontSize = 16.sp)
                    }
                    val f = if (duration > 0) (position.toFloat() / duration).coerceIn(0f, 1f) else 0f
                    Box(Modifier.fillMaxWidth().height(6.dp).background(Color(0x33FFFFFF), RoundedCornerShape(3.dp))) {
                        Box(Modifier.fillMaxHeight().fillMaxWidth(f).background(Tv.accent, RoundedCornerShape(3.dp)))
                    }
                    Row {
                        Text(clock(position), color = Tv.muted, fontSize = 15.sp)
                        Spacer(Modifier.weight(1f))
                        Text("◀ 10 s · OK pause · 30 s ▶", color = Tv.muted, fontSize = 14.sp)
                        Spacer(Modifier.weight(1f))
                        Text(if (duration > 0) "-" + clock(duration - position) else if (vm.player.tuning) "Loading…" else "", color = Tv.muted, fontSize = 15.sp)
                    }
                }
            }
        }
    }
}
