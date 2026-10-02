package io.gotvh.tv.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * The playback bar's buttons, the same on live TV and recordings: Guide · Channels · Recordings ·
 * Search, then what fits what's playing (Record / Live, or Restart). Down from the bar reaches
 * them; Left/Right choose, OK opens. Whatever is playing keeps playing behind what opens.
 */
@Composable
fun BarButtons(labels: List<String>, selected: Int?) {
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        labels.forEachIndexed { i, label ->
            val sel = selected == i
            Text(
                label, fontSize = 17.sp, fontWeight = if (sel) FontWeight.Bold else FontWeight.Normal,
                color = if (sel) Color.Black else Tv.text,
                modifier = Modifier
                    .background(if (sel) Tv.accent else Color(0x26FFFFFF), RoundedCornerShape(18.dp))
                    .padding(horizontal = 18.dp, vertical = 8.dp),
            )
        }
    }
}

/** The four buttons every playback bar starts with. */
val COMMON_BUTTONS = listOf("▦  Guide", "☰  Channels", "▶  Recordings", "⌕  Search")
