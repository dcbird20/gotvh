package io.gotvh.tv.mobile

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.gotvh.tv.AppViewModel
import io.gotvh.tv.data.Channel
import io.gotvh.tv.data.Program
import io.gotvh.tv.nowSec
import io.gotvh.tv.ui.Tv
import io.gotvh.tv.ui.dayLabel
import io.gotvh.tv.ui.timeRange

/**
 * Search the guide (title, subtitle, description) and your recordings as you type. Tap a
 * programme for Watch / Record / Record series; tap a recording to play it.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SearchView(vm: AppViewModel, onClose: () -> Unit, onWatch: () -> Unit) {
    val context = LocalContext.current
    val focus = remember { FocusRequester() }
    var picked by remember { mutableStateOf<Pair<Channel, Program>?>(null) }
    val now = nowSec()
    LaunchedEffect(Unit) {
        focus.requestFocus()
        vm.loadRecordings()
    }
    BackHandler(onBack = onClose)

    Column(Modifier.fillMaxSize().background(Tv.bg)) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(end = 12.dp, top = 8.dp)) {
            IconButton(onClick = onClose) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") }
            OutlinedTextField(
                value = vm.searchQuery,
                onValueChange = { vm.search(it) },
                singleLine = true,
                placeholder = { Text("Search programmes and recordings") },
                trailingIcon = {
                    if (vm.searchQuery.isNotEmpty()) IconButton(onClick = { vm.search("") }) { Icon(Icons.Filled.Close, contentDescription = "Clear") }
                },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = Tv.accent, cursorColor = Tv.accent, focusedTextColor = Tv.text, unfocusedTextColor = Tv.text),
                modifier = Modifier.weight(1f).focusRequester(focus),
            )
        }
        FilterChip(
            selected = vm.searchDescriptions,
            onClick = { vm.setSearchDescriptions(!vm.searchDescriptions) },
            label = { Text("Include descriptions") },
            modifier = Modifier.padding(start = 16.dp, top = 4.dp),
        )
        val recordings = vm.searchRecordings()
        val programmes = vm.searchResults
        Text(
            when {
                vm.searching -> "Searching…"
                vm.searchQuery.trim().length < 2 -> "Type at least two letters: a programme, a team, an actor…"
                recordings.isEmpty() && programmes.isEmpty() -> "Nothing in the guide or your recordings matches."
                else -> "${programmes.size} in the guide" + if (recordings.isNotEmpty()) " · ${recordings.size} in your recordings" else ""
            },
            color = Tv.muted, fontSize = 13.sp, modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
        )
        LazyColumn(Modifier.fillMaxSize()) {
            if (recordings.isNotEmpty()) {
                item { Section("Your recordings") }
                items(recordings, key = { "r" + it.uuid }) { r ->
                    Row(
                        Modifier.fillMaxWidth().clickable { vm.playRecording(r, fromStart = !r.inProgress) }.padding(horizontal = 16.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Text("▶", color = Tv.accent, fontSize = 14.sp, modifier = Modifier.width(18.dp))
                        Column(Modifier.weight(1f)) {
                            Text(r.title + if (r.subtitle.isNotBlank()) " · ${r.subtitle}" else "", color = Tv.text, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(
                                listOfNotNull("Recorded ${dayLabel(r.start)}", r.channelName.ifBlank { null },
                                    when { r.isRecordingNow -> "● recording"; r.inProgress -> "${r.minutesLeft} min left"; r.isWatched -> "✓ watched"; else -> "new" },
                                ).joinToString(" · "),
                                color = Tv.muted, fontSize = 12.sp, maxLines = 1,
                            )
                        }
                    }
                }
            }
            if (programmes.isNotEmpty()) {
                item { Section("In the guide") }
                items(programmes, key = { "p" + it.eventId }) { p ->
                    val ch = vm.channels.firstOrNull { it.uuid == p.channelUuid }
                    Row(
                        Modifier.fillMaxWidth().clickable { if (ch != null) picked = ch to p }.padding(horizontal = 16.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Box(Modifier.width(18.dp), contentAlignment = Alignment.Center) {
                            if (p.isScheduled) Box(Modifier.size(9.dp).background(Tv.rec, CircleShape))
                            else if (p.isAiring(now)) Box(Modifier.size(9.dp).background(Tv.accent, CircleShape))
                        }
                        Column(Modifier.weight(1f)) {
                            Text(p.title + if (p.subtitle.isNotBlank()) " · ${p.subtitle}" else "", color = Tv.text, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(
                                listOfNotNull(
                                    if (p.isAiring(now)) "On now" else "${dayLabel(p.start)} ${timeRange(context, p.start, p.stop)}",
                                    ch?.label, if (p.isScheduled) "will record" else null,
                                ).joinToString(" · "),
                                color = Tv.muted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            )
                        }
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

@Composable
private fun Section(title: String) {
    Text(title, color = Tv.accent, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(start = 16.dp, top = 12.dp, bottom = 4.dp))
}
