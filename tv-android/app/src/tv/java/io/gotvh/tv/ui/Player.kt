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
