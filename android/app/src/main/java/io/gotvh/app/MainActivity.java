package io.gotvh.app;

import android.os.Bundle;
import android.view.KeyEvent;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
	@Override
	public void onCreate(Bundle savedInstanceState) {
		registerPlugin(NativeVideoPlugin.class);
		super.onCreate(savedInstanceState);
	}

	@Override
	public boolean dispatchKeyEvent(KeyEvent event) {
		if (event.getAction() != KeyEvent.ACTION_DOWN) {
			return super.dispatchKeyEvent(event);
		}

		int keyCode = event.getKeyCode();
		if (keyCode == KeyEvent.KEYCODE_BACK || keyCode == KeyEvent.KEYCODE_ESCAPE) {
			dispatchBackToWeb();
			return true;
		}

		if (isSelectKeyCode(keyCode)) {
			dispatchSelectToWeb(keyCode);
			return true;
		}

		return super.dispatchKeyEvent(event);
	}

	@Override
	public void onBackPressed() {
		dispatchBackToWeb();
	}

	@Override
	public boolean onKeyDown(int keyCode, KeyEvent event) {
		return super.onKeyDown(keyCode, event);
	}

	private void dispatchBackToWeb() {
		dispatchKeyToWeb("BrowserBack", "BrowserBack", KeyEvent.KEYCODE_BACK);
	}

	private void dispatchSelectToWeb(int keyCode) {
		dispatchKeyToWeb("BrowserSelect", "BrowserSelect", keyCode);
	}

	private boolean isSelectKeyCode(int keyCode) {
		return keyCode == KeyEvent.KEYCODE_DPAD_CENTER
			|| keyCode == KeyEvent.KEYCODE_ENTER
			|| keyCode == KeyEvent.KEYCODE_NUMPAD_ENTER
			|| keyCode == KeyEvent.KEYCODE_SPACE
			|| keyCode == KeyEvent.KEYCODE_BUTTON_A
			|| keyCode == KeyEvent.KEYCODE_BUTTON_SELECT
			|| keyCode == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE;
	}

	private void dispatchKeyToWeb(String key, String code, int keyCode) {
		if (bridge == null) {
			return;
		}

		WebView webView = bridge.getWebView();
		if (webView == null) {
			return;
		}

		webView.evaluateJavascript(
			"(function(){"
				+ "try {"
				+ "  var defineKeyProps = function(event) {"
				+ "    Object.defineProperty(event, 'keyCode', { configurable: true, get: function(){ return " + keyCode + "; } });"
				+ "    Object.defineProperty(event, 'which', { configurable: true, get: function(){ return " + keyCode + "; } });"
				+ "    return event;"
				+ "  };"
				+ "  var active = document.activeElement;"
				+ "  var target = document.querySelector('[data-channel-uuid].tv-focused, [data-channel-uuid]:focus, .channel-card.channel-card--focused, .channel-card.tv-focused, .channel-card:focus, .tv-focused, button:focus, [tabindex=\"0\"]:focus');"
				+ "  if (!target && active && active !== document.body) { target = active; }"
				+ "  var dispatchKeyboard = function(node) {"
				+ "    var keyboardEvent = defineKeyProps(new KeyboardEvent('keydown', { key: '" + key + "', code: '" + code + "', bubbles: true, cancelable: true }));"
				+ "    node.dispatchEvent(keyboardEvent);"
				+ "  };"
				+ "  if (target && target !== document) {"
				+ "    if (typeof target.focus === 'function') { target.focus(); }"
				+ "    dispatchKeyboard(target);"
				+ "  } else {"
				+ "    dispatchKeyboard(document);"
				+ "  }"
				+ "  document.dispatchEvent(new CustomEvent('gotvh-native-key', { detail: { key: '" + key + "', code: '" + code + "', keyCode: " + keyCode + " } }));"
				+ "} catch (e) {}"
				+ "})();",
			null
		);
	}
}