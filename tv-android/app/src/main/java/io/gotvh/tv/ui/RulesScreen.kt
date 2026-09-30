package io.gotvh.tv.ui

import android.view.KeyEvent
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.gotvh.tv.AppViewModel
import io.gotvh.tv.data.AutorecRule

/** Auto-record rules: see them, switch them on or off, delete. Editing stays in the admin app. */
@Composable
fun RulesScreen(vm: AppViewModel) {
    val focus = remember { FocusRequester() }
    var index by remember { mutableIntStateOf(0) }
    var action by remember { mutableStateOf<AutorecRule?>(null) }
    var confirmDelete by remember { mutableStateOf<AutorecRule?>(null) }
    val rules = vm.rules
    val dialogOpen = action != null || confirmDelete != null

    LaunchedEffect(Unit) { focus.requestFocus() }
    LaunchedEffect(dialogOpen, vm.menuOpen) { if (!dialogOpen && !vm.menuOpen) focus.requestFocus() }
    LaunchedEffect(rules.size) { index = index.coerceIn(0, (rules.size - 1).coerceAtLeast(0)) }
    BackHandler(enabled = !dialogOpen) { vm.goLive() }

    Box(
        Modifier
            .fillMaxSize()
            .background(Tv.bg)
            .focusRequester(focus)
            .focusable()
            .onPreviewKeyEvent { ev ->
                if (dialogOpen || ev.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                when (ev.nativeKeyEvent.keyCode) {
                    KeyEvent.KEYCODE_DPAD_UP -> index = (index - 1).coerceAtLeast(0)
                    KeyEvent.KEYCODE_DPAD_DOWN -> index = (index + 1).coerceAtMost((rules.size - 1).coerceAtLeast(0))
                    KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> action = rules.getOrNull(index)
                    KeyEvent.KEYCODE_MENU -> vm.menuOpen = true
                    else -> return@onPreviewKeyEvent false
                }
                true
            },
    ) {
        Column(Modifier.fillMaxSize().padding(horizontal = 40.dp, vertical = 28.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Auto-record rules", color = Tv.text, fontSize = 28.sp, fontWeight = FontWeight.Bold)
                Spacer(Modifier.weight(1f))
                Text("OK switch on/off or delete · edit rules in the admin app · Back TV", color = Tv.muted, fontSize = 13.sp)
            }
            Spacer(Modifier.height(18.dp))
            if (rules.isEmpty()) {
                Text("No rules. In the guide, OK on a programme → Record series creates one.", color = Tv.muted, fontSize = 18.sp)
            } else {
                SelectList(Modifier.fillMaxSize(), rules.size, index, true) { i, sel ->
                    val r = rules[i]
                    val fg = if (sel) Color.Black else Tv.text
                    val sub = if (sel) Color(0xAA000000) else Tv.muted
                    Column {
                        Text(r.label, color = if (r.enabled) fg else sub, fontSize = 18.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(
                            listOfNotNull(
                                if (r.enabled) "On" else "Off",
                                r.channelUuid.takeIf { it.isNotBlank() }?.let { vm.channelName(it) } ?: "Any channel",
                                r.title.takeIf { it.isNotBlank() && it != r.name }?.let { "matches “$it”" },
                                r.comment.takeIf { it.isNotBlank() },
                            ).joinToString("  ·  "),
                            color = sub, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        }

        action?.let { r ->
            ActionDialog(
                r.label,
                listOf(if (r.enabled) "This rule is on: matching programmes are recorded." else "This rule is off."),
                listOf(
                    (if (r.enabled) "Switch off" else "Switch on") to { action = null; vm.setRuleEnabled(r, !r.enabled) },
                    "Delete" to { action = null; confirmDelete = r },
                    "Close" to { action = null },
                ),
                onClose = { action = null },
            )
        }
        confirmDelete?.let { r ->
            ActionDialog(
                "Delete the rule “${r.label}”?",
                listOf("Recordings it already scheduled stay scheduled; nothing new is recorded by it."),
                listOf("Cancel" to { confirmDelete = null }, "Delete" to { confirmDelete = null; vm.deleteRule(r) }),
                onClose = { confirmDelete = null },
            )
        }
    }
}
