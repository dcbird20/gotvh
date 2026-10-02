package io.gotvh.tv.mobile

import android.app.Activity
import android.content.pm.ActivityInfo
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
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
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.gotvh.tv.AppViewModel
import io.gotvh.tv.data.Program
import io.gotvh.tv.nowSec
import io.gotvh.tv.ui.ChannelLogo
import io.gotvh.tv.ui.Tv
import io.gotvh.tv.ui.clock
import io.gotvh.tv.ui.timeOf
import io.gotvh.tv.ui.timeRange
import kotlinx.coroutines.delay

private const val BACK_MS = 10_000L
private const val FORWARD_MS = 30_000L

/**
 * Live TV: the video on top (tap it for the controls: pause, −10 s / +30 s, Live, Record, full
 * screen), the channel list under it (tap to switch). Sideways, the video fills the screen.
 */
@Composable
fun LiveTab(vm: AppViewModel, fullScreen: Boolean) {
    val player = vm.player
    var controlsUntil by remember { mutableLongStateOf(System.currentTimeMillis() + 4000) }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(1000)
            now = System.currentTimeMillis()
        }
    }
    LaunchedEffect(vm.currentIndex) { controlsUntil = System.currentTimeMillis() + 4000 }
    val controls = now < controlsUntil || player.paused
    fun poke() { controlsUntil = System.currentTimeMillis() + 4000; now = System.currentTimeMillis() }

    val video: @Composable (Modifier) -> Unit = { mod ->
        Box(
            mod
                .background(Color.Black)
                .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) {
                    if (controls && !player.paused) controlsUntil = 0 else poke()
                },
        ) {
            VideoSurface(player, Modifier.fillMaxSize())
            val message = player.status ?: if (player.tuning) "Tuning…" else if (vm.loading && vm.channels.isEmpty()) "Connecting to Tvheadend…" else null
            if (message != null) {
                Box(Modifier.fillMaxSize().padding(16.dp), contentAlignment = Alignment.Center) {
                    Text(message, color = Tv.text, fontSize = 15.sp,
                        modifier = Modifier.background(Tv.panel, RoundedCornerShape(10.dp)).padding(horizontal = 16.dp, vertical = 10.dp))
                }
            }
            if (controls) LiveControls(vm, fullScreen, onAction = { poke() })
        }
    }

    if (fullScreen) {
        video(Modifier.fillMaxSize())
        return
    }
    Column(Modifier.fillMaxSize()) {
        video(Modifier.fillMaxWidth().aspectRatio(16f / 9f))
        NowPlaying(vm)
        ChannelList(vm)
    }
}

/** Over the video: play/pause and skipping in the middle, where you are in the pause buffer below. */
@Composable
private fun LiveControls(vm: AppViewModel, fullScreen: Boolean, onAction: () -> Unit) {
    val player = vm.player
    val activity = LocalContext.current as? Activity
    val shifted = player.paused || player.isBehindLive
    Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(Color(0x66000000), Color(0x22000000), Color(0xAA000000))))) {
        // Middle: −10 s · play/pause · +30 s
        Row(Modifier.align(Alignment.Center), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(28.dp)) {
            if (player.canPause) {
                RoundButton("−10", 52) { player.seekLive(-BACK_MS); onAction() }
                RoundButton(if (player.paused) "▶" else "❚❚", 68) { player.togglePause(); onAction() }
                RoundButton("+30", 52) { player.seekLive(FORWARD_MS); onAction() }
            }
        }
        // Bottom: LIVE / behind, buffer bar, Live, Record, full screen.
        Column(Modifier.align(Alignment.BottomStart).fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp)) {
            if (player.canPause) {
                val span = player.liveBufferMs.coerceAtLeast(1)
                val behind = player.behindLiveMs
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(if (player.paused) "Paused" else if (shifted) "−" + clock(behind) else "● LIVE",
                        color = if (shifted) Tv.accent else Tv.rec, fontSize = 13.sp, fontWeight = FontWeight.Bold)
                    Box(Modifier.weight(1f).height(4.dp).background(Color(0x44FFFFFF), RoundedCornerShape(2.dp))) {
                        Box(Modifier.fillMaxHeight().fillMaxWidth((1f - behind.toFloat() / span).coerceIn(0f, 1f))
                            .background(if (shifted) Tv.accent else Color(0x99FFFFFF), RoundedCornerShape(2.dp)))
                    }
                }
            } else {
                player.pauseUnavailable?.let { Text(it, color = Tv.muted, fontSize = 12.sp, maxLines = 2) }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (shifted) TextButton(onClick = { player.goLive(); onAction() }) { Text("Live", color = Tv.text) }
                val ch = vm.currentChannel
                val on = ch?.let { vm.nowAndNext(it.uuid, nowSec() - player.behindLiveMs / 1000).first }
                if (on != null) {
                    TextButton(onClick = { if (on.isScheduled) vm.cancelRecording(on) else vm.record(on); onAction() }) {
                        Text(if (on.isScheduled) "■ Stop recording" else "● Record", color = if (on.isScheduled) Tv.text else Tv.rec)
                    }
                }
                Spacer(Modifier.weight(1f))
                TextButton(onClick = {
                    activity?.requestedOrientation = if (fullScreen) ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
                    else ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                    onAction()
                }) { Text(if (fullScreen) "Exit full screen" else "Full screen", color = Tv.text) }
            }
        }
    }
}

@Composable
private fun RoundButton(label: String, size: Int, onClick: () -> Unit) {
    Box(
        Modifier.size(size.dp).background(Color(0x66000000), CircleShape).clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { Text(label, color = Color.White, fontSize = (size / 3).sp, fontWeight = FontWeight.Bold) }
}

/** The channel and programme on screen, under the video. */
@Composable
private fun NowPlaying(vm: AppViewModel) {
    val context = LocalContext.current
    val ch = vm.currentChannel ?: return
    val at = nowSec() - vm.player.behindLiveMs / 1000
    val (on, next) = vm.nowAndNext(ch.uuid, at)
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            if (ch.number.isNotEmpty()) Text(ch.number, color = Tv.accent, fontSize = 18.sp, fontWeight = FontWeight.Bold)
            Text(ch.name, color = Tv.text, fontSize = 18.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (on?.isRecordingNow == true) Box(Modifier.size(10.dp).background(Tv.rec, CircleShape))
        }
        if (on != null) {
            Text(on.title + if (on.subtitle.isNotBlank()) " · ${on.subtitle}" else "", color = Tv.text, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(timeRange(context, on.start, on.stop) + (next?.let { " · Next ${timeOf(context, it.start)} ${it.title}" } ?: ""),
                color = Tv.muted, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        } else {
            Text("No guide information", color = Tv.muted, fontSize = 14.sp)
        }
    }
}

/** Every channel with what's on now; tap to switch. */
@Composable
private fun ChannelList(vm: AppViewModel) {
    val context = LocalContext.current
    val state = rememberLazyListState()
    LaunchedEffect(Unit) { state.scrollToItem((vm.currentIndex - 2).coerceAtLeast(0)) }
    val nowS = nowSec()
    LazyColumn(state = state, modifier = Modifier.fillMaxSize()) {
        itemsIndexed(vm.channels, key = { _, c -> c.uuid }) { i, ch ->
            val sel = i == vm.currentIndex
            val on: Program? = vm.nowAndNext(ch.uuid, nowS).first
            Row(
                Modifier
                    .fillMaxWidth()
                    .clickable { vm.tune(i) }
                    .background(if (sel) Color(0x26F5B63F) else Color.Transparent)
                    .padding(horizontal = 16.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Text(ch.number, color = Tv.accent, fontSize = 14.sp, fontWeight = FontWeight.Bold, modifier = Modifier.width(44.dp), maxLines = 1)
                ChannelLogo(ch, vm.imageLoader, 36.dp)
                Column(Modifier.weight(1f)) {
                    Text(ch.name, color = Tv.text, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(on?.title ?: "No guide information", color = Tv.muted, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (on != null) {
                        val f = ((nowS - on.start).toFloat() / (on.stop - on.start).coerceAtLeast(1)).coerceIn(0f, 1f)
                        Box(Modifier.padding(top = 4.dp).fillMaxWidth(0.7f).height(3.dp).background(Color(0x33FFFFFF))) {
                            Box(Modifier.fillMaxHeight().fillMaxWidth(f).background(Tv.accent))
                        }
                    }
                }
                if (on != null) Text(timeOf(context, on.stop), color = Tv.muted, fontSize = 12.sp)
            }
        }
    }
}
