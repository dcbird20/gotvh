package io.gotvh.tv.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.gotvh.tv.AppViewModel
import io.gotvh.tv.Screen
import kotlinx.coroutines.launch

/** First run (and Menu → settings in the guide): server address and sign-in. */
@Composable
fun SetupScreen(vm: AppViewModel) {
    var server by remember { mutableStateOf(vm.settings.server.ifBlank { "http://" }) }
    var username by remember { mutableStateOf(vm.settings.username) }
    var password by remember { mutableStateOf(vm.settings.password) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val first = remember { FocusRequester() }

    LaunchedEffect(Unit) { first.requestFocus() }
    BackHandler(enabled = vm.settings.isConfigured) { vm.screen = Screen.Watch }

    fun submit() {
        if (busy) return
        busy = true
        error = null
        scope.launch {
            error = vm.testAndSave(server, username, password)
            busy = false
        }
    }

    Box(Modifier.fillMaxSize().background(Tv.bg), contentAlignment = Alignment.Center) {
        Column(Modifier.width(560.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text("GoTVH", color = Tv.accent, fontSize = 34.sp, fontWeight = FontWeight.Bold)
            Text("Connect to your Tvheadend server", color = Tv.muted, fontSize = 18.sp)
            OutlinedTextField(
                value = server, onValueChange = { server = it },
                label = { Text("Server address") },
                placeholder = { Text("http://192.168.1.222:9981") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next),
                modifier = Modifier.fillMaxWidth().focusRequester(first),
            )
            OutlinedTextField(
                value = username, onValueChange = { username = it },
                label = { Text("Username") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = password, onValueChange = { password = it },
                label = { Text("Password") },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { submit() }),
                modifier = Modifier.fillMaxWidth(),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                TvButton(if (busy) "Connecting…" else "Connect") { submit() }
                if (vm.settings.isConfigured) TvButton("Cancel") { vm.screen = Screen.Watch }
            }
            error?.let { Text(it, color = Tv.error, fontSize = 16.sp) }
            Text("Use the same address and account as the GoTVH admin web app.", color = Tv.muted, fontSize = 14.sp)
        }
    }
}
