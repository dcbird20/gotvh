package io.gotvh.tv.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/*
 * The player's on-screen controls, the same for live TV and recordings (see WatchScreen /
 * PlaybackScreen). Everything here is real focus: the arrows move a visible highlight, OK presses
 * it, Back closes. The progress bar is a row of its own: with it highlighted, Left/Right move
 * back / forward.
 */

/**
 * A highlighted-when-focused tile for anything bigger than a button (the mini guide, the number
 * pad). Like [TvButton], it only reacts to an OK that went down on it.
 */
@Composable
fun TvTile(
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
    content: @Composable (focused: Boolean) -> Unit,
) {
    var focused by remember { mutableStateOf(false) }
    var armed by remember { mutableStateOf(false) }
    Box(
        modifier
            .onFocusChanged {
                focused = it.isFocused
                if (!it.isFocused) armed = false
            }
            .onPreviewKeyEvent { ev ->
                if (!isOkKey(ev.nativeKeyEvent.keyCode)) return@onPreviewKeyEvent false
                when (ev.type) {
                    KeyEventType.KeyDown -> {
                        if (ev.nativeKeyEvent.repeatCount > 0) return@onPreviewKeyEvent true
                        armed = true
                        false
                    }
                    KeyEventType.KeyUp -> if (armed) { armed = false; false } else true
                    else -> false
                }
            }
            .clip(RoundedCornerShape(10.dp))
            .background(if (focused) Tv.accent else Color(0x1FFFFFFF))
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = onClick),
    ) { content(focused) }
}

/**
 * The controls over the video: [header] (what's playing), the progress row ([progress]; Left/Right
 * there call [onScrub]), a row of [buttons] (the first one highlighted when the controls open), and
 * optionally more rows [below] (the mini guide).
 */
@Composable
fun PlayerControls(
    header: @Composable ColumnScope.() -> Unit,
    progress: @Composable (focused: Boolean) -> Unit,
    onScrub: (forward: Boolean) -> Unit,
    buttons: List<Pair<String, () -> Unit>>,
    below: (@Composable () -> Unit)? = null,
) {
    val first = remember { FocusRequester() }
    var progressFocused by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { runCatching { first.requestFocus() } }
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.BottomCenter) {
        Column(
            Modifier
                .fillMaxWidth()
                .background(Brush.verticalGradient(listOf(Color.Transparent, Color(0xE60B1220), Color(0xF70B1220))))
                .padding(start = 48.dp, end = 48.dp, top = 70.dp, bottom = 30.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            header()
            // The progress row: highlight it (Up from the buttons) and Left/Right move back / forward.
            Box(
                Modifier
                    .fillMaxWidth()
                    .onFocusChanged { progressFocused = it.isFocused }
                    .onPreviewKeyEvent { ev ->
                        if (ev.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                        when (ev.nativeKeyEvent.keyCode) {
                            android.view.KeyEvent.KEYCODE_DPAD_LEFT -> { onScrub(false); true }
                            android.view.KeyEvent.KEYCODE_DPAD_RIGHT -> { onScrub(true); true }
                            else -> false
                        }
                    }
                    .focusable()
                    .then(if (progressFocused) Modifier.border(2.dp, Tv.accent, RoundedCornerShape(8.dp)) else Modifier)
                    .padding(horizontal = 10.dp, vertical = 8.dp),
            ) { progress(progressFocused) }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                buttons.forEachIndexed { i, (label, action) ->
                    TvButton(label, if (i == 0) Modifier.focusRequester(first) else Modifier) { action() }
                }
            }
            below?.invoke()
        }
    }
}

/** A thin progress bar with times either side (or any labels). */
@Composable
fun ProgressLine(fraction: Float, left: String, right: String, accent: Color = Tv.accent, hint: String? = null) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Box(Modifier.fillMaxWidth().height(6.dp).background(Color(0x33FFFFFF), RoundedCornerShape(3.dp))) {
            Box(Modifier.fillMaxWidth(fraction.coerceIn(0f, 1f)).height(6.dp).background(accent, RoundedCornerShape(3.dp)))
        }
        Row {
            Text(left, color = Tv.muted, fontSize = 15.sp)
            Spacer(Modifier.weight(1f))
            if (hint != null) Text(hint, color = Tv.accent, fontSize = 14.sp)
            Spacer(Modifier.weight(1f))
            Text(right, color = Tv.muted, fontSize = 15.sp)
        }
    }
}

/**
 * Type a channel number on screen (for remotes without number keys): 1–9, ⌫, 0, Go. Go — or a
 * number that only one channel can start with — tunes.
 */
@Composable
fun NumberPad(onTune: (String) -> Unit, onClose: () -> Unit) {
    var typed by remember { mutableStateOf("") }
    val first = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { first.requestFocus() } }
    BackHandler { onClose() }
    val keys = listOf("1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "Go")
    Box(Modifier.fillMaxSize().background(Color(0x88000000)), contentAlignment = Alignment.Center) {
        Column(
            Modifier.background(Tv.panelSolid, RoundedCornerShape(16.dp)).padding(28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("Channel number", color = Tv.muted, fontSize = 16.sp)
            Text(typed.ifEmpty { "–" }, color = Tv.accent, fontSize = 44.sp, fontWeight = FontWeight.Bold)
            keys.chunked(3).forEachIndexed { row, three ->
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    three.forEachIndexed { col, k ->
                        TvTile(
                            modifier = Modifier.size(width = 96.dp, height = 64.dp).then(if (row == 0 && col == 0) Modifier.focusRequester(first) else Modifier),
                            onClick = {
                                when (k) {
                                    "⌫" -> typed = typed.dropLast(1)
                                    "Go" -> if (typed.isNotEmpty()) onTune(typed)
                                    else -> if (typed.length < 6) typed += k
                                }
                            },
                        ) { focused ->
                            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                                Text(k, color = if (focused) Color.Black else Tv.text, fontSize = 24.sp, fontWeight = FontWeight.SemiBold)
                            }
                        }
                    }
                }
            }
            Spacer(Modifier.width(1.dp))
        }
    }
}

/**
 * Left / Right with nothing on screen, for live TV and recordings: a tap skips ([tap]); holding
 * starts rewinding / fast-forwarding at 2×. While that runs: Left / Right change speed
 * (−32× … 32×), OK plays from there (Back, handled by the screen, cancels). Remotes with ⏪ ⏩
 * keys start it straight away.
 */
class TrickKeys {
    /** Left or Right went down and hasn't been released or held long enough yet. */
    private var pending = 0

    fun handle(ev: androidx.compose.ui.input.key.KeyEvent, player: io.gotvh.tv.player.TvPlayer, tap: (forward: Boolean) -> Unit): Boolean {
        val k = ev.nativeKeyEvent.keyCode
        val down = ev.type == KeyEventType.KeyDown
        val first = down && ev.nativeKeyEvent.repeatCount == 0
        val left = android.view.KeyEvent.KEYCODE_DPAD_LEFT
        val right = android.view.KeyEvent.KEYCODE_DPAD_RIGHT
        if (player.trickSpeed != 0) {
            pending = 0
            when {
                k == right || k == android.view.KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> { if (first) player.trickFaster(); return true }
                k == left || k == android.view.KeyEvent.KEYCODE_MEDIA_REWIND -> { if (first) player.trickSlower(); return true }
                isOkKey(k) || k == android.view.KeyEvent.KEYCODE_MEDIA_PLAY || k == android.view.KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> {
                    if (first) player.trickPlay(); return true
                }
                k == android.view.KeyEvent.KEYCODE_DPAD_UP || k == android.view.KeyEvent.KEYCODE_DPAD_DOWN || k == android.view.KeyEvent.KEYCODE_INFO -> return true
                else -> return false
            }
        }
        if (k == android.view.KeyEvent.KEYCODE_MEDIA_FAST_FORWARD || k == android.view.KeyEvent.KEYCODE_MEDIA_REWIND) {
            val forward = k == android.view.KeyEvent.KEYCODE_MEDIA_FAST_FORWARD
            if (first) { if (player.canTrick(forward)) player.trickStart(forward) else tap(forward) }
            return true
        }
        if (k != left && k != right) return false
        val forward = k == right
        when {
            first -> pending = k
            down && pending == k && player.canTrick(forward) -> { pending = 0; player.trickStart(forward) }
            down -> {}
            ev.type == KeyEventType.KeyUp && pending == k -> { pending = 0; tap(forward) }
        }
        return true
    }
}

/** Top left while rewinding / fast-forwarding: the speed, and what the keys do. */
@Composable
fun TrickBadge(speed: Int) {
    Box(Modifier.fillMaxSize().padding(36.dp), contentAlignment = Alignment.TopStart) {
        Column(Modifier.background(Tv.panel, RoundedCornerShape(12.dp)).padding(horizontal = 22.dp, vertical = 12.dp)) {
            Text((if (speed > 0) "⏩  " else "⏪  ") + "${kotlin.math.abs(speed)}×", color = Tv.accent, fontSize = 36.sp, fontWeight = FontWeight.Bold)
            Text("◀ ▶ speed  ·  OK play  ·  Back cancel", color = Tv.muted, fontSize = 14.sp)
        }
    }
}
