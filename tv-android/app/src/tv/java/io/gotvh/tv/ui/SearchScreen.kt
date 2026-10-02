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
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.gotvh.tv.AppViewModel
import io.gotvh.tv.data.Program
import io.gotvh.tv.data.Recording
import io.gotvh.tv.nowSec

/** One search result: a recording you have, or a programme in the guide. */
private sealed class Hit {
    data class Rec(val r: Recording) : Hit()
    data class Prog(val p: Program) : Hit()
}

/**
 * Search the guide (title, subtitle, description) and your recordings. Type with the on-screen
 * keyboard (or its microphone); Down moves into the results. OK on a programme: on now → watch,
 * later → Record / Record series; OK on a recording plays it.
 */
@Composable
fun SearchScreen(vm: AppViewModel) {
    val context = LocalContext.current
    val field = remember { FocusRequester() }
    val list = remember { FocusRequester() }
    val toggle = remember { FocusRequester() }
    var inList by remember { mutableStateOf(false) }
    var index by remember { mutableIntStateOf(0) }
    var detail by remember { mutableStateOf<Program?>(null) }
    var recording by remember { mutableStateOf<Recording?>(null) }
    val now = nowSec()

    val hits: List<Hit> = vm.searchRecordings().take(20).map { Hit.Rec(it) } + vm.searchResults.map { Hit.Prog(it) }
    LaunchedEffect(hits.size) { index = index.coerceIn(0, (hits.size - 1).coerceAtLeast(0)) }
    LaunchedEffect(Unit) { field.requestFocus() }
    LaunchedEffect(detail, recording) { if (detail == null && recording == null && inList) list.requestFocus() }

    BackHandler(enabled = detail == null && recording == null) { if (inList) field.requestFocus() else vm.backToVideo() }

    fun open(hit: Hit) {
        when (hit) {
            is Hit.Rec -> recording = hit.r
            is Hit.Prog -> {
                val p = hit.p
                detail = p // the card: Watch first if it's on now, else Record
            }
        }
    }

    Box(Modifier.fillMaxSize().background(Color(0xE60B1220))) {
        Column(Modifier.fillMaxSize().padding(horizontal = 48.dp, vertical = 28.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Search", color = Tv.text, fontSize = 26.sp, fontWeight = FontWeight.Bold)
                Spacer(Modifier.weight(1f))
                Text("OK on the box to type · ▼ options, results · OK details · Back", color = Tv.muted, fontSize = 13.sp)
            }
            Spacer(Modifier.height(12.dp))
            OutlinedTextField(
                value = vm.searchQuery,
                onValueChange = { vm.search(it) },
                singleLine = true,
                placeholder = { Text("A programme, team, actor…") },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = { if (hits.isNotEmpty()) list.requestFocus() else toggle.requestFocus() }),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedTextColor = Tv.text, unfocusedTextColor = Tv.text,
                    focusedBorderColor = Tv.accent, cursorColor = Tv.accent,
                ),
                modifier = Modifier
                    .fillMaxWidth()
                    .focusRequester(field)
                    .onPreviewKeyEvent { ev ->
                        if (ev.type == KeyEventType.KeyDown && ev.nativeKeyEvent.keyCode == KeyEvent.KEYCODE_DPAD_DOWN) {
                            toggle.requestFocus()
                            true
                        } else {
                            false
                        }
                    },
            )
            Spacer(Modifier.height(10.dp))
            // Titles only, or titles and descriptions (remembered). Down from here: the results.
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                TvButton(
                    if (vm.searchDescriptions) "✓  Include descriptions" else "Include descriptions",
                    Modifier
                        .focusRequester(toggle)
                        .onPreviewKeyEvent { ev ->
                            if (ev.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                            when (ev.nativeKeyEvent.keyCode) {
                                KeyEvent.KEYCODE_DPAD_DOWN -> { if (hits.isNotEmpty()) list.requestFocus(); true }
                                KeyEvent.KEYCODE_DPAD_UP -> { field.requestFocus(); true }
                                else -> false
                            }
                        },
                ) { vm.toggleSearchDescriptions() }
                Text(if (vm.searchDescriptions) "Searching titles and descriptions" else "Searching titles", color = Tv.muted, fontSize = 14.sp)
            }
            Spacer(Modifier.height(10.dp))
            Text(
                when {
                    vm.searching -> "Searching…"
                    vm.searchQuery.trim().length < 2 -> "Type at least two letters."
                    hits.isEmpty() -> "Nothing in the guide or your recordings matches."
                    else -> "${vm.searchResults.size} in the guide" + vm.searchRecordings().size.let { if (it > 0) " · $it in your recordings" else "" }
                },
                color = Tv.muted, fontSize = 14.sp,
            )
            Spacer(Modifier.height(8.dp))
            // Results: virtual focus (one row highlighted), like the guide.
            Box(
                Modifier
                    .fillMaxWidth()
                    .weight(1f)
                    .focusRequester(list)
                    .onFocusChanged { inList = it.isFocused }
                    .focusable()
                    .onPreviewKeyEvent { ev ->
                        if (detail != null || recording != null) return@onPreviewKeyEvent false
                        if (isHeldOk(ev)) return@onPreviewKeyEvent true
                        if (ev.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                        when (ev.nativeKeyEvent.keyCode) {
                            KeyEvent.KEYCODE_DPAD_UP -> if (index == 0) toggle.requestFocus() else index--
                            KeyEvent.KEYCODE_DPAD_DOWN -> index = (index + 1).coerceAtMost((hits.size - 1).coerceAtLeast(0))
                            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER ->
                                hits.getOrNull(index)?.let { open(it) }
                            else -> return@onPreviewKeyEvent false
                        }
                        true
                    },
            ) {
                SelectList(Modifier.fillMaxSize(), hits.size, index, inList) { i, sel ->
                    val fg = if (sel) Color.Black else Tv.text
                    val sub = if (sel) Color(0xAA000000) else Tv.muted
                    when (val h = hits[i]) {
                        is Hit.Rec -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            Text("REC", color = if (sel) Color.Black else Tv.accent, fontSize = 12.sp, fontWeight = FontWeight.Bold, modifier = Modifier.width(44.dp))
                            Column(Modifier.weight(1f)) {
                                Text(h.r.title + if (h.r.subtitle.isNotBlank()) " · ${h.r.subtitle}" else "", color = fg, fontSize = 18.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(
                                    listOfNotNull("Recorded ${dayLabel(h.r.start)}", h.r.channelName.ifBlank { null },
                                        when { h.r.isRecordingNow -> "● recording"; h.r.inProgress -> "${h.r.minutesLeft} min left"; h.r.isWatched -> "✓ watched"; else -> "new" },
                                    ).joinToString(" · "),
                                    color = sub, fontSize = 14.sp, maxLines = 1,
                                )
                            }
                        }
                        is Hit.Prog -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            Box(Modifier.width(44.dp), contentAlignment = Alignment.CenterStart) {
                                if (h.p.isScheduled) Box(Modifier.size(10.dp).background(Tv.rec, CircleShape))
                                else if (h.p.isAiring(now)) Text("NOW", color = if (sel) Color.Black else Tv.accent, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                            }
                            Column(Modifier.weight(1f)) {
                                Text(h.p.title + if (h.p.subtitle.isNotBlank()) " · ${h.p.subtitle}" else "", color = fg, fontSize = 18.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(
                                    listOfNotNull("${dayLabel(h.p.start)} ${timeRange(context, h.p.start, h.p.stop)}", vm.channelName(h.p.channelUuid),
                                        if (h.p.isScheduled) "will record" else null).joinToString(" · "),
                                    color = sub, fontSize = 14.sp, maxLines = 1,
                                )
                                vm.matchSnippet(h.p.title, h.p.subtitle, h.p.description)?.let {
                                    Text(it, color = if (sel) Color(0xCC000000) else Tv.accent, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                }
                            }
                        }
                    }
                }
            }
        }
        recording?.let { r -> RecordingCard(vm, r, onClose = { recording = null }) }
        detail?.let { p ->
            ProgramDetails(vm, p, onClose = { detail = null }, onWatch = {
                detail = null
                vm.tuneUuid(p.channelUuid)
                vm.screen = io.gotvh.tv.Screen.Watch
            })
        }
    }
}
