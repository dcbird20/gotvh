package io.gotvh.tv.mobile

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.gotvh.tv.AppViewModel
import io.gotvh.tv.data.Channel
import io.gotvh.tv.data.Genre
import io.gotvh.tv.data.Program
import io.gotvh.tv.nowSec
import io.gotvh.tv.ui.ChannelLogo
import io.gotvh.tv.ui.Tv
import io.gotvh.tv.ui.dayLabel
import io.gotvh.tv.ui.timeOf
import io.gotvh.tv.ui.timeRange

private const val SLOT = 1800L

/**
 * The guide for a phone: pick a time (Now, then every half hour for two days) and see what's on
 * every channel then. Tap a programme for its details: Watch (if it's on now), Record, Record series.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GuideTab(vm: AppViewModel, onWatch: () -> Unit) {
    val context = LocalContext.current
    val now = nowSec()
    val firstSlot = now - Math.floorMod(now, SLOT)
    val slots = remember(firstSlot) { listOf(0L) + (1..96).map { firstSlot + it * SLOT } } // 0 = now
    var slot by rememberSaveable { mutableLongStateOf(0L) }
    val at = if (slot == 0L) now else slot
    var picked by remember { mutableStateOf<Pair<Channel, Program>?>(null) }

    LaunchedEffect(at / SLOT) { vm.ensureGuide(at - 3600, at + 4 * 3600) }

    Column(Modifier.fillMaxSize()) {
        LazyRow(contentPadding = PaddingValues(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            items(slots) { s ->
                val label = when {
                    s == 0L -> "Now"
                    Math.floorMod(s + java.util.TimeZone.getDefault().getOffset(s * 1000) / 1000, 86400L) == 0L -> "${dayLabel(s)} ${timeOf(context, s)}"
                    else -> timeOf(context, s)
                }
                FilterChip(selected = slot == s, onClick = { slot = s }, label = { Text(label) })
            }
        }
        if (slot != 0L) Text(dayLabel(slot), color = Tv.muted, fontSize = 13.sp, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
        LazyColumn(Modifier.fillMaxSize()) {
            itemsIndexed(vm.channels, key = { _, c -> c.uuid }) { _, ch ->
                val list = vm.programsFor(ch.uuid)
                val on = list.firstOrNull { it.start <= at && it.stop > at }
                val next = list.firstOrNull { it.start > at && !it.placeholder }
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable(enabled = on != null) { on?.let { picked = ch to it } }
                        .padding(horizontal = 16.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Column(Modifier.width(56.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        ChannelLogo(ch, vm.imageLoader, 34.dp)
                        Text(ch.number, color = Tv.accent, fontSize = 12.sp, fontWeight = FontWeight.Bold, maxLines = 1)
                    }
                    Column(Modifier.weight(1f)) {
                        val genre = on?.takeUnless { it.placeholder }?.let { Genre.of(it) }
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            if (genre != null) Box(Modifier.size(8.dp).background(genre.color, CircleShape))
                            if (on?.isScheduled == true) Box(Modifier.size(8.dp).background(Tv.rec, CircleShape))
                            Text(
                                if (on == null || on.placeholder) ch.name else on.title,
                                color = if (on == null || on.placeholder) Tv.muted else Tv.text,
                                fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            )
                        }
                        if (on != null && !on.placeholder) {
                            Text(timeRange(context, on.start, on.stop), color = Tv.muted, fontSize = 12.sp)
                            if (on.isAiring(now)) {
                                val f = ((now - on.start).toFloat() / (on.stop - on.start).coerceAtLeast(1)).coerceIn(0f, 1f)
                                Box(Modifier.padding(top = 3.dp).fillMaxWidth(0.6f).height(3.dp).background(Color(0x33FFFFFF))) {
                                    Box(Modifier.fillMaxHeight().fillMaxWidth(f).background(Tv.accent))
                                }
                            }
                        } else {
                            Text("No guide information", color = Tv.muted, fontSize = 12.sp)
                        }
                        if (next != null) Text("Then ${timeOf(context, next.start)} ${next.title}", color = Tv.muted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
    }

    picked?.let { (ch, p) ->
        ModalBottomSheet(onDismissRequest = { picked = null }, containerColor = Tv.panelSolid) {
            ProgramSheet(vm, ch, p, onPick = { picked = ch to it }, onWatch = {
                picked = null
                val i = vm.channels.indexOfFirst { it.uuid == ch.uuid }
                if (i >= 0) vm.tune(i)
                onWatch()
            }, onDone = { picked = null })
        }
    }
}

/** A programme's details, what it can do, and what's on the channel after it. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ProgramSheet(vm: AppViewModel, ch: Channel, p: Program, onPick: (Program) -> Unit, onWatch: () -> Unit, onDone: () -> Unit) {
    val context = LocalContext.current
    val now = nowSec()
    Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 28.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(if (p.placeholder) ch.name else p.title, color = Tv.text, fontSize = 22.sp, fontWeight = FontWeight.Bold)
        if (p.subtitle.isNotBlank()) Text(p.subtitle, color = Tv.muted, fontSize = 15.sp)
        Text(listOfNotNull("${dayLabel(p.start)} ${timeRange(context, p.start, p.stop)}", ch.label, Genre.of(p)?.label).joinToString("  ·  "),
            color = Tv.muted, fontSize = 13.sp)
        when {
            p.isRecordingNow -> Text("● Recording now", color = Tv.rec, fontSize = 14.sp)
            p.isScheduled -> Text("● Will be recorded", color = Tv.rec, fontSize = 14.sp)
        }
        if (p.description.isNotBlank()) Text(p.description, color = Tv.text, fontSize = 14.sp)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (p.isAiring(now) || p.placeholder) Button(onClick = onWatch) { Text("Watch") }
            if (!p.placeholder) {
                if (p.isScheduled) {
                    OutlinedButton(onClick = { vm.cancelRecording(p); onDone() }) { Text(if (p.isRecordingNow) "Stop recording" else "Don’t record") }
                } else if (p.stop > now) {
                    OutlinedButton(onClick = { vm.record(p); onDone() }) { Text("Record") }
                    if (p.seriesLink.isNotBlank()) OutlinedButton(onClick = { vm.record(p, series = true); onDone() }) { Text("Record series") }
                }
            }
        }
        val later = vm.upNext(ch.uuid, 6, p.start).filter { !it.placeholder }
        if (later.isNotEmpty()) {
            Spacer(Modifier.height(6.dp))
            Text("Later on ${ch.name}", color = Tv.muted, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            later.forEach { q ->
                Row(
                    Modifier.fillMaxWidth().clickable { onPick(q) }.padding(vertical = 8.dp, horizontal = 4.dp),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(timeOf(context, q.start), color = Tv.muted, fontSize = 13.sp, modifier = Modifier.width(72.dp))
                    if (q.isScheduled) Box(Modifier.size(8.dp).background(Tv.rec, CircleShape))
                    Text(q.title, color = Tv.text, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}

