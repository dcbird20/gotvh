package io.gotvh.tv.mobile

import android.app.Activity
import android.content.res.Configuration
import android.view.ViewGroup
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.List
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.media3.ui.PlayerView
import io.gotvh.tv.AppViewModel
import io.gotvh.tv.Screen
import io.gotvh.tv.player.TvPlayer
import io.gotvh.tv.ui.SetupScreen
import io.gotvh.tv.ui.Tv
import kotlinx.coroutines.delay

/** The three tabs at the bottom. */
enum class Tab(val label: String) { Live("Live TV"), Guide("Guide"), Recordings("Recordings") }

/**
 * The phone / tablet app: Live TV (video with the channel list under it; sideways = full screen),
 * Guide (what's on at a chosen time, tap to watch or record), Recordings (shows, resume, watched).
 * Built on the same AppViewModel and player as the TV app, so pausing live TV (Tvheadend's
 * timeshift over HTSP) and watched state work the same way.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MobileApp(vm: AppViewModel) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = Tv.accent, onPrimary = Color.Black, background = Tv.bg, surface = Tv.bg,
            surfaceContainer = Tv.panelSolid, onSurface = Tv.text, onSurfaceVariant = Tv.muted,
        ),
    ) {
        var tab by rememberSaveable { mutableStateOf(Tab.Live) }
        var searchOpen by rememberSaveable { mutableStateOf(false) }
        val landscape = LocalConfiguration.current.orientation == Configuration.ORIENTATION_LANDSCAPE

        // Keep the view model's idea of the screen in step: it decides what resumes after the app returns.
        LaunchedEffect(tab, vm.screen) {
            if (vm.screen == Screen.Setup || vm.screen == Screen.Playback) return@LaunchedEffect
            when (tab) {
                Tab.Live -> {
                    vm.screen = Screen.Watch
                    // Back on the Live tab: start the channel again if it was stopped.
                    if (vm.client != null && !vm.player.exo.isPlaying && !vm.player.tuning && !vm.player.paused) {
                        vm.tune(vm.currentIndex)
                    }
                }
                Tab.Guide -> {
                    vm.player.stop() // no video on screen: free the tuner
                    vm.screen = Screen.Guide
                    vm.freshenGuide()
                }
                Tab.Recordings -> {
                    vm.player.stop()
                    vm.screen = Screen.Recordings
                    vm.loadRecordings()
                }
            }
        }

        val fullScreenVideo = (vm.screen == Screen.Playback) || (landscape && tab == Tab.Live && vm.screen != Screen.Setup && !searchOpen)
        SystemBars(hidden = fullScreenVideo)

        Box(Modifier.fillMaxSize().background(Tv.bg)) {
            when {
                vm.screen == Screen.Setup -> SetupScreen(vm)
                vm.screen == Screen.Playback -> RecordingPlayer(vm)
                searchOpen -> SearchView(
                    vm,
                    onClose = {
                        searchOpen = false
                        if (tab == Tab.Live) vm.tune(vm.currentIndex)
                    },
                    onWatch = { searchOpen = false; tab = Tab.Live },
                )
                fullScreenVideo -> LiveTab(vm, fullScreen = true)
                else -> Scaffold(
                    containerColor = Tv.bg,
                    topBar = {
                        TopAppBar(
                            title = { Text(if (tab == Tab.Live) "GoTVH" else tab.label, fontWeight = FontWeight.SemiBold) },
                            actions = {
                                IconButton(onClick = { vm.player.stop(); searchOpen = true }) {
                                    Icon(Icons.Filled.Search, contentDescription = "Search")
                                }
                                IconButton(onClick = { vm.player.stop(); vm.screen = Screen.Setup }) {
                                    Icon(Icons.Filled.Settings, contentDescription = "Settings")
                                }
                            },
                            colors = TopAppBarDefaults.topAppBarColors(containerColor = Tv.bg),
                        )
                    },
                    bottomBar = {
                        NavigationBar(containerColor = Tv.panelSolid) {
                            Tab.entries.forEach { t ->
                                NavigationBarItem(
                                    selected = tab == t,
                                    onClick = { tab = t },
                                    icon = {
                                        Icon(
                                            when (t) {
                                                Tab.Live -> Icons.Filled.PlayArrow
                                                Tab.Guide -> Icons.Filled.DateRange
                                                Tab.Recordings -> Icons.Filled.List
                                            },
                                            contentDescription = null,
                                        )
                                    },
                                    label = { Text(t.label) },
                                )
                            }
                        }
                    },
                ) { padding ->
                    Box(Modifier.padding(padding).fillMaxSize()) {
                        when (tab) {
                            Tab.Live -> LiveTab(vm, fullScreen = false)
                            Tab.Guide -> GuideTab(vm, onWatch = { tab = Tab.Live })
                            Tab.Recordings -> RecordingsTab(vm)
                        }
                    }
                }
            }
            Notice(vm)
        }
        BackHandler(enabled = vm.screen == Screen.Setup && vm.settings.isConfigured) { vm.screen = Screen.Watch }
    }
}

/** Hide the status and navigation bars while the video fills the screen. */
@Composable
private fun SystemBars(hidden: Boolean) {
    val activity = LocalContext.current as? Activity ?: return
    LaunchedEffect(hidden) {
        val controller = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
        if (hidden) {
            controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            controller.hide(WindowInsetsCompat.Type.systemBars())
        } else {
            controller.show(WindowInsetsCompat.Type.systemBars())
        }
    }
}

/** The video. One player for the whole app; this just shows it. */
@Composable
fun VideoSurface(player: TvPlayer, modifier: Modifier = Modifier) {
    AndroidView(
        factory = { ctx ->
            PlayerView(ctx).apply {
                useController = false
                this.player = player.exo
                setShutterBackgroundColor(android.graphics.Color.BLACK)
                keepScreenOn = true
                layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            }
        },
        modifier = modifier.background(Color.Black),
    )
}

/** Short messages ("Recording “NOVA”", connection problems). */
@Composable
private fun Notice(vm: AppViewModel) {
    val text = vm.notice ?: return
    LaunchedEffect(text) {
        delay(4500)
        if (vm.notice == text) vm.notice = null
    }
    Box(Modifier.fillMaxSize().padding(bottom = 96.dp, start = 16.dp, end = 16.dp), contentAlignment = Alignment.BottomCenter) {
        Column(Modifier.background(Color(0xF0131E34), RoundedCornerShape(10.dp)).padding(horizontal = 18.dp, vertical = 12.dp)) {
            Text(text, color = Tv.text, fontSize = 15.sp)
        }
    }
}
