package io.gotvh.tv

import android.os.Bundle
import android.view.ViewGroup
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.ui.PlayerView
import io.gotvh.tv.player.TvPlayer
import io.gotvh.tv.ui.GuideScreen
import io.gotvh.tv.ui.MainMenu
import io.gotvh.tv.ui.PlaybackScreen
import io.gotvh.tv.ui.RecordingsScreen
import io.gotvh.tv.ui.RulesScreen
import io.gotvh.tv.ui.SetupScreen
import io.gotvh.tv.ui.Tv
import io.gotvh.tv.ui.WatchScreen
import kotlinx.coroutines.delay

class MainActivity : ComponentActivity() {

    private val vm: AppViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContent {
            MaterialTheme(colorScheme = darkColorScheme(primary = Tv.accent)) {
                GoTvhApp(vm)
            }
        }
    }

    // Stop the stream when the app goes to the background (frees the tuner), resume on return.
    override fun onStop() {
        super.onStop()
        if (vm.screen == Screen.Playback) vm.saveRecordingPosition()
        vm.player.stop()
    }

    override fun onStart() {
        super.onStart()
        vm.resumeIfStopped()
    }
}

@Composable
fun GoTvhApp(vm: AppViewModel) {
    Box(Modifier.fillMaxSize().background(Color.Black)) {
        VideoSurface(vm.player)
        when (vm.screen) {
            Screen.Setup -> SetupScreen(vm)
            Screen.Watch -> WatchScreen(vm)
            Screen.Guide -> GuideScreen(vm)
            Screen.Recordings -> RecordingsScreen(vm)
            Screen.Rules -> RulesScreen(vm)
            Screen.Playback -> PlaybackScreen(vm)
        }
        if (vm.menuOpen) MainMenu(vm)
        Notice(vm)
    }
}

/** The video, always underneath; the guide and overlays are drawn on top of it. */
@Composable
private fun VideoSurface(player: TvPlayer) {
    AndroidView(
        factory = { ctx ->
            PlayerView(ctx).apply {
                useController = false
                this.player = player.exo
                isFocusable = false
                descendantFocusability = ViewGroup.FOCUS_BLOCK_DESCENDANTS
                setShutterBackgroundColor(android.graphics.Color.BLACK)
                keepScreenOn = true
            }
        },
        modifier = Modifier.fillMaxSize(),
    )
}

/** Short messages ("Recording “NOVA”", connection problems) at the top of the screen. */
@Composable
private fun Notice(vm: AppViewModel) {
    val text = vm.notice ?: return
    LaunchedEffect(text) {
        delay(5000)
        if (vm.notice == text) vm.notice = null
    }
    Box(Modifier.fillMaxSize().padding(top = 28.dp), contentAlignment = Alignment.TopCenter) {
        Text(
            text,
            color = Tv.text,
            fontSize = 18.sp,
            modifier = Modifier
                .background(Color(0xE6131E34), RoundedCornerShape(10.dp))
                .padding(horizontal = 22.dp, vertical = 12.dp),
        )
    }
}
