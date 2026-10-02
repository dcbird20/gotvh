package io.gotvh.tv

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import io.gotvh.tv.mobile.MobileApp

/** The phone / tablet app. Same core as the TV app (Tvheadend, HTSP, player); touch screens. */
class MainActivity : ComponentActivity() {

    private val vm: AppViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent { MobileApp(vm) }
    }

    // Stop the stream in the background (frees the tuner); pick it up again on return.
    override fun onStop() {
        super.onStop()
        if (vm.screen == Screen.Playback) vm.saveRecordingPosition(force = true)
        vm.player.stop()
    }

    override fun onStart() {
        super.onStart()
        // Only where a video was showing: live TV or a recording, not while browsing the guide.
        if (vm.screen == Screen.Watch || vm.screen == Screen.Playback) vm.resumeIfStopped()
    }
}
