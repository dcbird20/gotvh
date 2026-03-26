package io.gotvh.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.JSObject;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "NativeVideo")
public class NativeVideoPlugin extends Plugin {
    @PluginMethod
    public void open(PluginCall call) {
        String url = call.getString("url");
        String title = call.getString("title", "Live TV");
        String mimeType = call.getString("mimeType", "video/mp4");
        String authHeader = call.getString("authHeader");
        String fallbackProfiles = call.getString("fallbackProfiles");
        Boolean allowLiveFallback = call.getBoolean("allowLiveFallback", false);
        String currentChannelId = call.getString("currentChannelId");
        String liveChannelsJson = call.getString("liveChannelsJson");
        String returnTo = call.getString("returnTo");
        String returnToken = call.getString("returnToken");
        String programTitle = call.getString("programTitle");
        String programTime = call.getString("programTime");
        String programDescription = call.getString("programDescription");
        String programCategory = call.getString("programCategory");
        String recordingRef = call.getString("recordingRef");

        if (url == null || url.trim().isEmpty()) {
            call.reject("Missing stream URL");
            return;
        }

        Intent intent = new Intent(getActivity(), NativeVideoActivity.class);
        intent.putExtra(NativeVideoActivity.EXTRA_URL, url);
        intent.putExtra(NativeVideoActivity.EXTRA_TITLE, title);
        intent.putExtra(NativeVideoActivity.EXTRA_MIME_TYPE, mimeType);
        intent.putExtra(NativeVideoActivity.EXTRA_AUTH_HEADER, authHeader);
        intent.putExtra(NativeVideoActivity.EXTRA_FALLBACK_PROFILES, fallbackProfiles);
        intent.putExtra(NativeVideoActivity.EXTRA_ALLOW_LIVE_FALLBACK, allowLiveFallback != null && allowLiveFallback);
        intent.putExtra(NativeVideoActivity.EXTRA_CURRENT_CHANNEL_ID, currentChannelId);
        intent.putExtra(NativeVideoActivity.EXTRA_LIVE_CHANNELS_JSON, liveChannelsJson);
        intent.putExtra(NativeVideoActivity.EXTRA_RETURN_TO, returnTo);
        intent.putExtra(NativeVideoActivity.EXTRA_RETURN_TOKEN, returnToken);
        intent.putExtra(NativeVideoActivity.EXTRA_PROGRAM_TITLE, programTitle);
        intent.putExtra(NativeVideoActivity.EXTRA_PROGRAM_TIME, programTime);
        intent.putExtra(NativeVideoActivity.EXTRA_PROGRAM_DESCRIPTION, programDescription);
        intent.putExtra(NativeVideoActivity.EXTRA_PROGRAM_CATEGORY, programCategory);
        intent.putExtra(NativeVideoActivity.EXTRA_RECORDING_REF, recordingRef);
        getActivity().startActivity(intent);

        JSObject result = new JSObject();
        result.put("launched", true);
        call.resolve(result);
    }

    @PluginMethod
    public void openExternal(PluginCall call) {
        String url = call.getString("url");
        String title = call.getString("title", "Video");
        String mimeType = call.getString("mimeType");
        String authHeader = call.getString("authHeader");
        String preferredPackage = call.getString("preferredPackage");
        String chooserTitle = call.getString("chooserTitle", title);

        if (url == null || url.trim().isEmpty()) {
            call.reject("Missing playback URL");
            return;
        }

        Intent baseIntent = new Intent(Intent.ACTION_VIEW);
        Uri uri = Uri.parse(url);
        if (mimeType != null && !mimeType.trim().isEmpty()) {
            baseIntent.setDataAndType(uri, mimeType);
        } else {
            baseIntent.setData(uri);
        }
        baseIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        baseIntent.putExtra(Intent.EXTRA_TITLE, title);
        attachHttpHeaders(baseIntent, authHeader);

        try {
            if (preferredPackage != null && !preferredPackage.trim().isEmpty()) {
                Intent preferredIntent = new Intent(baseIntent);
                preferredIntent.setPackage(preferredPackage.trim());
                getActivity().startActivity(preferredIntent);

                JSObject result = new JSObject();
                result.put("launched", true);
                result.put("package", preferredPackage.trim());
                call.resolve(result);
                return;
            }
        } catch (Exception preferredError) {
            android.util.Log.w("NativeVideo", "Preferred external player failed: " + preferredError.getMessage());
        }

        try {
            Intent chooserIntent = Intent.createChooser(new Intent(baseIntent), chooserTitle);
            chooserIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(chooserIntent);

            JSObject result = new JSObject();
            result.put("launched", true);
            call.resolve(result);
        } catch (Exception genericError) {
            call.reject("External playback failed: " + genericError.getMessage());
        }
    }

    @PluginMethod
    public void openKodiHtsp(PluginCall call) {
        String url = call.getString("url");
        String fallbackUrl = call.getString("fallbackUrl");

        if (url == null || url.trim().isEmpty()) {
            call.reject("Missing HTSP URL");
            return;
        }

        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

        try {
            Intent kodiIntent = new Intent(intent);
            kodiIntent.setPackage("org.xbmc.kodi");
            getActivity().startActivity(kodiIntent);
        } catch (Exception kodiError) {
            android.util.Log.w("NativeVideo", "Kodi not found or failed to handle htsp://, error: " + kodiError.getMessage());

            try {
                getActivity().startActivity(intent);
            } catch (Exception genericError) {
                android.util.Log.w("NativeVideo", "No app handles htsp:// URL, error: " + genericError.getMessage());

                if (fallbackUrl != null && !fallbackUrl.trim().isEmpty()) {
                    try {
                        Intent fallbackIntent = new Intent(Intent.ACTION_VIEW, Uri.parse(fallbackUrl));
                        fallbackIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        getActivity().startActivity(fallbackIntent);
                        JSObject result = new JSObject();
                        result.put("launched", true);
                        result.put("fallback", true);
                        call.resolve(result);
                        return;
                    } catch (Exception fallbackError) {
                        call.reject("Fallback HTTP playback failed: " + fallbackError.getMessage());
                        return;
                    }
                } else {
                    call.reject("HTSP handler not found, and no fallback URL provided");
                    return;
                }
            }
        }

        JSObject result = new JSObject();
        result.put("launched", true);
        call.resolve(result);
    }

    private void attachHttpHeaders(Intent intent, String authHeader) {
        if (authHeader == null || authHeader.trim().isEmpty()) {
            return;
        }

        Bundle headers = new Bundle();
        headers.putString("Authorization", authHeader);
        intent.putExtra("com.android.browser.headers", headers);
        intent.putExtra("android.media.intent.extra.HTTP_HEADERS", headers);
    }
}