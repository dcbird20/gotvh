package io.gotvh.tv.mobile

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.gotvh.tv.AppViewModel
import io.gotvh.tv.ui.Tv
import io.gotvh.tv.ui.clock
import kotlinx.coroutines.delay

/**
 * A recording, full screen: tap for the controls (back, −10 s / play-pause / +30 s, a seek bar).
 * Where you stop is saved in Tvheadend as you go, so the TV and Kodi resume from the same point.
 */
@Composable
fun RecordingPlayer(vm: AppViewModel) {
    val r = vm.playing ?: return
    val exo = vm.player.exo
    var position by remember { mutableLongStateOf(0L) }
    var duration by remember { mutableLongStateOf(0L) }
    var paused by remember { mutableStateOf(false) }
    var controlsUntil by remember { mutableLongStateOf(System.currentTimeMillis() + 4000) }
    var clockNow by remember { mutableLongStateOf(System.currentTimeMillis()) }
    var dragging by remember { mutableStateOf(false) }
    var dragValue by remember { mutableFloatStateOf(0f) }

    fun poke() { controlsUntil = System.currentTimeMillis() + 4000; clockNow = System.currentTimeMillis() }
    fun seek(delta: Long) {
        val d = exo.duration
        val target = (exo.currentPosition + delta).coerceAtLeast(0)
        exo.seekTo(if (d > 0) target.coerceAtMost(d - 1000) else target)
        poke()
    }

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

    val controls = paused || clockNow < controlsUntil || vm.player.tuning
    Box(
        Modifier
            .fillMaxSize()
            .background(Color.Black)
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) {
                if (controls && !paused) controlsUntil = 0 else poke()
            },
    ) {
        VideoSurface(vm.player, Modifier.fillMaxSize())
        vm.player.status?.let { msg ->
            Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
                Text(msg, color = Tv.text, fontSize = 15.sp, modifier = Modifier.background(Tv.panel, RoundedCornerShape(10.dp)).padding(14.dp))
            }
        }
        if (!controls) return@Box
        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(Color(0x99000000), Color(0x22000000), Color(0xBB000000))))) {
            Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = { vm.leavePlayback() }) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back", tint = Color.White) }
                Column(Modifier.weight(1f)) {
                    Text(r.title, color = Color.White, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (r.subtitle.isNotBlank()) Text(r.subtitle, color = Tv.muted, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                if (vm.player.growing) Text("● Still recording", color = Tv.rec, fontSize = 13.sp, modifier = Modifier.padding(end = 12.dp))
            }
            Row(Modifier.align(Alignment.Center), horizontalArrangement = Arrangement.spacedBy(32.dp), verticalAlignment = Alignment.CenterVertically) {
                Round("−10", 52) { seek(-10_000) }
                Round(if (paused) "▶" else "❚❚", 68) {
                    exo.playWhenReady = !exo.playWhenReady
                    paused = !exo.playWhenReady
                    if (paused) vm.saveRecordingPosition(force = true)
                    poke()
                }
                Round("+30", 52) { seek(30_000) }
            }
            Column(Modifier.align(Alignment.BottomStart).fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp)) {
                val fraction = if (duration > 0) (position.toFloat() / duration).coerceIn(0f, 1f) else 0f
                Slider(
                    value = if (dragging) dragValue else fraction,
                    onValueChange = { dragging = true; dragValue = it; poke() },
                    onValueChangeFinished = {
                        if (duration > 0) exo.seekTo((dragValue * duration).toLong())
                        dragging = false
                        poke()
                    },
                    colors = SliderDefaults.colors(thumbColor = Tv.accent, activeTrackColor = Tv.accent),
                )
                Row {
                    Text(clock(if (dragging) (dragValue * duration).toLong() else position), color = Color.White, fontSize = 13.sp)
                    Spacer(Modifier.weight(1f))
                    Text(if (duration > 0) "−" + clock(duration - position) else if (vm.player.tuning) "Loading…" else "", color = Color.White, fontSize = 13.sp)
                }
            }
        }
    }
}

@Composable
private fun Round(label: String, size: Int, onClick: () -> Unit) {
    Box(Modifier.size(size.dp).background(Color(0x66000000), CircleShape).clickable(onClick = onClick), contentAlignment = Alignment.Center) {
        Text(label, color = Color.White, fontSize = (size / 3).sp, fontWeight = FontWeight.Bold)
    }
}

