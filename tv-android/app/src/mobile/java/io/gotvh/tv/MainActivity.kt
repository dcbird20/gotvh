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
        // Pairing for away from home: read the QR code from the admin app (Devices).
        vm.qrScanner = { onText ->
            val options = com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions.Builder()
                .setBarcodeFormats(com.google.mlkit.vision.barcode.common.Barcode.FORMAT_QR_CODE)
                .build()
            com.google.mlkit.vision.codescanner.GmsBarcodeScanning.getClient(this, options).startScan()
                .addOnSuccessListener { onText(it.rawValue.orEmpty()) }
                .addOnFailureListener { vm.notice = "Couldn't open the QR scanner (${it.message}). Type the code instead." }
        }
        setContent { MobileApp(vm) }
    }

    override fun onDestroy() {
        vm.qrScanner = null  // it refers to this activity
        super.onDestroy()
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
        // Left home, or came back: switch between the home and away addresses.
        vm.checkRoute()
    }
}
