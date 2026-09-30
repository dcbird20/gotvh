package io.gotvh.tv.ui

import android.content.Context
import android.text.format.DateFormat
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.ImageLoader
import coil.compose.AsyncImage
import io.gotvh.tv.data.Channel
import java.util.Calendar
import java.util.Date

/** Colours for a dark TV screen. */
object Tv {
    val bg = Color(0xFF0B1220)
    val panel = Color(0xEE101A2E)
    val panelSolid = Color(0xFF131E34)
    val cell = Color(0x1AFFFFFF)
    val text = Color(0xFFF2F4F8)
    val muted = Color(0xFFA7B0C0)
    val accent = Color(0xFFF5B63F)
    val rec = Color(0xFFE5484D)
    val error = Color(0xFFFF8A80)
}

fun timeOf(context: Context, sec: Long): String = DateFormat.getTimeFormat(context).format(Date(sec * 1000))

fun timeRange(context: Context, start: Long, stop: Long): String = "${timeOf(context, start)} – ${timeOf(context, stop)}"

/** "Today", "Tomorrow", or "Wed 1 Oct". */
fun dayLabel(sec: Long): String {
    val day = Calendar.getInstance().apply { timeInMillis = sec * 1000 }
    val today = Calendar.getInstance()
    fun sameDay(a: Calendar, b: Calendar) = a.get(Calendar.YEAR) == b.get(Calendar.YEAR) && a.get(Calendar.DAY_OF_YEAR) == b.get(Calendar.DAY_OF_YEAR)
    if (sameDay(day, today)) return "Today"
    today.add(Calendar.DAY_OF_YEAR, 1)
    if (sameDay(day, today)) return "Tomorrow"
    return java.text.SimpleDateFormat("EEE d MMM", java.util.Locale.getDefault()).format(Date(sec * 1000))
}

/** A button for the remote: highlighted when focused, OK/Enter presses it. */
@Composable
fun TvButton(text: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    var focused by remember { mutableStateOf(false) }
    Box(
        modifier
            .onFocusChanged { focused = it.isFocused }
            .clip(RoundedCornerShape(8.dp))
            .background(if (focused) Tv.accent else Color(0x26FFFFFF))
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = onClick)
            .padding(horizontal = 22.dp, vertical = 11.dp),
    ) {
        Text(text, color = if (focused) Color.Black else Tv.text, fontSize = 17.sp, fontWeight = FontWeight.Medium)
    }
}

/** Channel logo from Tvheadend's image cache, or the channel number when there's none. */
@Composable
fun ChannelLogo(channel: Channel, loader: ImageLoader?, size: Dp, modifier: Modifier = Modifier) {
    Box(modifier.size(size), contentAlignment = Alignment.Center) {
        val icon = channel.icon
        if (icon != null && loader != null) {
            AsyncImage(model = icon, contentDescription = null, imageLoader = loader, contentScale = ContentScale.Fit, modifier = Modifier.size(size))
        } else {
            Text(
                channel.name.take(3).uppercase(), color = Tv.muted, fontSize = (size.value / 3).sp,
                fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Clip,
            )
        }
    }
}

/** A dialog of choices for the remote; the first button has focus, Back closes it. */
@androidx.compose.runtime.Composable
fun ActionDialog(
    title: String,
    lines: List<String>,
    actions: List<Pair<String, () -> Unit>>,
    onClose: () -> Unit,
) {
    val first = androidx.compose.runtime.remember { androidx.compose.ui.focus.FocusRequester() }
    androidx.compose.runtime.LaunchedEffect(title, actions.size) { first.requestFocus() }
    androidx.activity.compose.BackHandler { onClose() }
    Box(
        androidx.compose.ui.Modifier.fillMaxSize().background(Color(0xAA000000)),
        contentAlignment = Alignment.Center,
    ) {
        androidx.compose.foundation.layout.Column(
            androidx.compose.ui.Modifier
                .width(720.dp)
                .background(Tv.panelSolid, RoundedCornerShape(14.dp))
                .padding(30.dp),
            verticalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(10.dp),
        ) {
            Text(title, color = Tv.text, fontSize = 26.sp, fontWeight = FontWeight.Bold)
            lines.filter { it.isNotBlank() }.forEach { Text(it, color = Tv.muted, fontSize = 17.sp, maxLines = 6, overflow = TextOverflow.Ellipsis) }
            androidx.compose.foundation.layout.Spacer(androidx.compose.ui.Modifier.size(6.dp))
            androidx.compose.foundation.layout.Row(horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(12.dp)) {
                actions.forEachIndexed { i, (label, action) ->
                    TvButton(label, if (i == 0) androidx.compose.ui.Modifier.focusRequester(first) else androidx.compose.ui.Modifier) { action() }
                }
            }
        }
    }
}

/** "1:05:30" / "12:04". */
fun clock(ms: Long): String {
    val s = (ms / 1000).coerceAtLeast(0)
    val h = s / 3600
    val m = (s % 3600) / 60
    val sec = s % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, sec) else "%d:%02d".format(m, sec)
}
