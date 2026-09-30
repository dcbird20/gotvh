package io.gotvh.tv.ui

import android.view.KeyEvent
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.gotvh.tv.AppViewModel
import io.gotvh.tv.Screen

private val ITEMS = listOf(
    "Live TV" to Screen.Watch,
    "Guide" to Screen.Guide,
    "Recordings" to Screen.Recordings,
    "Auto-record rules" to Screen.Rules,
    "Settings" to Screen.Setup,
)

/** The Menu key's menu, over whatever is on screen. */
@Composable
fun MainMenu(vm: AppViewModel) {
    val focus = remember { FocusRequester() }
    var index by remember { mutableIntStateOf(ITEMS.indexOfFirst { it.second == vm.screen }.coerceAtLeast(0)) }
    LaunchedEffect(Unit) { focus.requestFocus() }
    BackHandler { vm.menuOpen = false }

    Box(
        Modifier
            .fillMaxSize()
            .background(Color(0x99000000))
            .focusRequester(focus)
            .focusable()
            .onPreviewKeyEvent { ev ->
                if (ev.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                when (ev.nativeKeyEvent.keyCode) {
                    KeyEvent.KEYCODE_DPAD_UP -> index = Math.floorMod(index - 1, ITEMS.size)
                    KeyEvent.KEYCODE_DPAD_DOWN -> index = Math.floorMod(index + 1, ITEMS.size)
                    KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER, KeyEvent.KEYCODE_DPAD_RIGHT ->
                        vm.open(ITEMS[index].second)
                    KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_MENU -> vm.menuOpen = false
                    else -> return@onPreviewKeyEvent false
                }
                true
            },
    ) {
        Column(
            Modifier.fillMaxHeight().width(380.dp).background(Tv.panelSolid).padding(vertical = 40.dp, horizontal = 20.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text("GoTVH", color = Tv.accent, fontSize = 28.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(start = 14.dp, bottom = 18.dp))
            ITEMS.forEachIndexed { i, (label, _) ->
                val sel = i == index
                Text(
                    label, color = if (sel) Color.Black else Tv.text, fontSize = 22.sp,
                    fontWeight = if (sel) FontWeight.Bold else FontWeight.Normal,
                    modifier = Modifier.fillMaxWidth()
                        .background(if (sel) Tv.accent else Color.Transparent, RoundedCornerShape(10.dp))
                        .padding(horizontal = 18.dp, vertical = 12.dp),
                )
            }
        }
    }
}
