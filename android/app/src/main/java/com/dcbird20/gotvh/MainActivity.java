package com.dcbird20.gotvh;

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
	public void onBackPressed() {
		dispatchBackToWeb();
	}

	@Override
	public boolean onKeyDown(int keyCode, KeyEvent event) {
		if (keyCode == KeyEvent.KEYCODE_BACK || keyCode == KeyEvent.KEYCODE_ESCAPE) {
			dispatchBackToWeb();
			return true;
		}

		return super.onKeyDown(keyCode, event);
	}

	private void dispatchBackToWeb() {
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
				+ "  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'BrowserBack', bubbles: true, cancelable: true }));"
				+ "} catch (e) {}"
				+ "})();",
			null
		);
	}
}
