package io.gotvh.app;

import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.content.Intent;
import android.view.KeyEvent;
import android.view.View;
import android.widget.Toast;
import android.widget.TextView;

import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.ui.PlayerView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class NativeVideoActivity extends AppCompatActivity {
    private static final long PROGRAM_INFO_TIMEOUT_MS = 9500L;
    public static final String EXTRA_URL = "streamUrl";
    public static final String EXTRA_TITLE = "streamTitle";
    public static final String EXTRA_MIME_TYPE = "streamMimeType";
    public static final String EXTRA_AUTH_HEADER = "streamAuthHeader";
    public static final String EXTRA_FALLBACK_PROFILES = "fallbackProfiles";
    public static final String EXTRA_ALLOW_LIVE_FALLBACK = "allowLiveFallback";
    public static final String EXTRA_CURRENT_CHANNEL_ID = "currentChannelId";
    public static final String EXTRA_LIVE_CHANNELS_JSON = "liveChannelsJson";
    public static final String EXTRA_RETURN_TO = "returnTo";
    public static final String EXTRA_RETURN_TOKEN = "returnToken";
    public static final String EXTRA_RETURN_CHANNEL_ID = "returnChannelId";
    public static final String EXTRA_PROGRAM_TITLE = "programTitle";
    public static final String EXTRA_PROGRAM_TIME = "programTime";
    public static final String EXTRA_PROGRAM_DESCRIPTION = "programDescription";
    public static final String EXTRA_PROGRAM_CATEGORY = "programCategory";

    private static final class LiveChannelEntry {
        final String uuid;
        final String name;

        LiveChannelEntry(String uuid, String name) {
            this.uuid = uuid;
            this.name = name;
        }
    }

    private ExoPlayer player;
    private PlayerView playerView;
    private String currentUrl;
    private String currentMimeType;
    private String authHeader;
    private boolean allowLiveFallback;
    private boolean retriedWithoutMime;
    private boolean retriedDirectStream;
    private int mimeTypeRetryCount = 0;
    private List<String> fallbackProfiles = new ArrayList<>();
    private final List<LiveChannelEntry> liveChannels = new ArrayList<>();
    private int activeProfileIndex = 0;
    private TextView statusOverlay;
    private View programInfoOverlay;
    private TextView programTitleView;
    private TextView programMetaView;
    private TextView programDescriptionView;
    private String currentChannelId;
    private String returnTo;
    private String returnToken;
    private String programTitle;
    private String programTime;
    private String programDescription;
    private String programCategory;
    private long lastChannelSurfAtMs = 0L;
    private final Handler overlayHandler = new Handler(Looper.getMainLooper());
    private final Runnable hideOverlayRunnable = () -> {
        if (statusOverlay != null) {
            statusOverlay.setVisibility(View.GONE);
        }
    };
    private final Runnable hideProgramInfoOverlayRunnable = () -> {
        if (programInfoOverlay != null) {
            programInfoOverlay.setVisibility(View.GONE);
        }
    };

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_native_video);

        playerView = findViewById(R.id.native_player_view);
        statusOverlay = findViewById(R.id.native_player_status_overlay);
        programInfoOverlay = findViewById(R.id.native_program_info_overlay);
        programTitleView = findViewById(R.id.native_program_title);
        programMetaView = findViewById(R.id.native_program_meta);
        programDescriptionView = findViewById(R.id.native_program_description);
        playerView.setUseController(true);
        playerView.setControllerAutoShow(true);
        playerView.setControllerHideOnTouch(false);
        playerView.setControllerShowTimeoutMs(4000);
        playerView.setFocusable(true);
        playerView.setFocusableInTouchMode(true);
        playerView.requestFocus();

        String url = getIntent().getStringExtra(EXTRA_URL);
        String title = getIntent().getStringExtra(EXTRA_TITLE);
        String mimeType = normalizeMimeType(getIntent().getStringExtra(EXTRA_MIME_TYPE), url);
        authHeader = getIntent().getStringExtra(EXTRA_AUTH_HEADER);
        fallbackProfiles = parseFallbackProfiles(getIntent().getStringExtra(EXTRA_FALLBACK_PROFILES));
        activeProfileIndex = resolveActiveProfileIndex(url, fallbackProfiles);
        allowLiveFallback = getIntent().getBooleanExtra(EXTRA_ALLOW_LIVE_FALLBACK, false);
        currentChannelId = normalizeValue(getIntent().getStringExtra(EXTRA_CURRENT_CHANNEL_ID));
        returnTo = normalizeValue(getIntent().getStringExtra(EXTRA_RETURN_TO));
        returnToken = normalizeValue(getIntent().getStringExtra(EXTRA_RETURN_TOKEN));
        programTitle = normalizeValue(getIntent().getStringExtra(EXTRA_PROGRAM_TITLE));
        programTime = normalizeValue(getIntent().getStringExtra(EXTRA_PROGRAM_TIME));
        programDescription = normalizeValue(getIntent().getStringExtra(EXTRA_PROGRAM_DESCRIPTION));
        programCategory = normalizeValue(getIntent().getStringExtra(EXTRA_PROGRAM_CATEGORY));
        liveChannels.clear();
        liveChannels.addAll(parseLiveChannels(getIntent().getStringExtra(EXTRA_LIVE_CHANNELS_JSON)));

        if (title != null && !title.trim().isEmpty()) {
            setTitle(title);
        }

        if (url == null || url.trim().isEmpty()) {
            Toast.makeText(this, "Missing stream URL", Toast.LENGTH_LONG).show();
            finish();
            return;
        }

        android.util.Log.d("NativeVideo", "Loading stream: " + url + " | mimeType: " + mimeType + " | auth: " + (authHeader != null ? "yes" : "no"));
        showProgramInfoOverlay();
        showStatusOverlay("Opening " + formatProfileLabel(getActiveProfileLabel()) + " playback", 2200);

        retriedWithoutMime = false;
        retriedDirectStream = false;
        mimeTypeRetryCount = 0;
        preparePlayback(url, mimeType);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (playerView != null) {
            playerView.requestFocus();
        }
    }

    @Override
    protected void onStop() {
        super.onStop();
        overlayHandler.removeCallbacks(hideOverlayRunnable);
        overlayHandler.removeCallbacks(hideProgramInfoOverlayRunnable);
        if (player != null) {
            player.release();
            player = null;
        }
    }

    @Override
    public void onBackPressed() {
        if (playerView != null && playerView.isControllerFullyVisible()) {
            playerView.hideController();
            return;
        }

        if (finishToReturnTarget()) {
            return;
        }

        super.onBackPressed();
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (event.getAction() != KeyEvent.ACTION_DOWN) {
            return super.dispatchKeyEvent(event);
        }

        int keyCode = event.getKeyCode();

        if (isDirectionalKey(keyCode) && playerView != null) {
            playerView.requestFocus();
            playerView.showController();
        }

        switch (keyCode) {
            case KeyEvent.KEYCODE_CHANNEL_UP:
            case KeyEvent.KEYCODE_PAGE_UP:
            case 427:
                return surfChannel(1);
            case KeyEvent.KEYCODE_CHANNEL_DOWN:
            case KeyEvent.KEYCODE_PAGE_DOWN:
            case 428:
                return surfChannel(-1);
            case KeyEvent.KEYCODE_BACK:
            case KeyEvent.KEYCODE_ESCAPE:
                onBackPressed();
                return true;
            case KeyEvent.KEYCODE_DPAD_CENTER:
            case KeyEvent.KEYCODE_ENTER:
            case KeyEvent.KEYCODE_NUMPAD_ENTER:
            case KeyEvent.KEYCODE_SPACE:
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_HEADSETHOOK:
                return togglePlayback();
            case KeyEvent.KEYCODE_MEDIA_PLAY:
                return setPlayWhenReady(true);
            case KeyEvent.KEYCODE_MEDIA_PAUSE:
            case KeyEvent.KEYCODE_MEDIA_STOP:
                return setPlayWhenReady(false);
            default:
                return super.dispatchKeyEvent(event);
        }
    }

    private void preparePlayback(String url, String mimeType) {
        currentUrl = url;
        currentMimeType = mimeType;

        if (player != null) {
            player.release();
            player = null;
        }

        DefaultHttpDataSource.Factory httpFactory = new DefaultHttpDataSource.Factory()
            .setAllowCrossProtocolRedirects(true)
            .setUserAgent("GoTVH-Android");

        if (authHeader != null && !authHeader.trim().isEmpty()) {
            Map<String, String> headers = new HashMap<>();
            headers.put("Authorization", authHeader);
            httpFactory.setDefaultRequestProperties(headers);
        }

        player = new ExoPlayer.Builder(this)
            .setMediaSourceFactory(new DefaultMediaSourceFactory(httpFactory))
            .build();

        playerView.setPlayer(player);
        player.addListener(new Player.Listener() {
            @Override
            public void onPlaybackStateChanged(int state) {
                if (state == Player.STATE_READY) {
                    boolean seekable = player.isCurrentMediaItemSeekable();
                    long duration = player.getDuration();
                    android.util.Log.d("NativeVideo", "Playback ready | Seekable: " + seekable + " | Duration: " + duration + "ms");
                    showStatusOverlay("Now playing", 1800);
                    if (!seekable && duration > 0) {
                        android.util.Log.w("NativeVideo", "Stream marked as non-seekable but has duration - this may be a buffered stream");
                    }
                }
            }

            @Override
            public void onIsPlayingChanged(boolean isPlaying) {
                showStatusOverlay(isPlaying ? "Playing" : "Paused", 1400);
            }

            @Override
            public void onPlayerError(PlaybackException error) {
                String codeName = error.getErrorCodeName();
                android.util.Log.w("NativeVideo", "Playback error: " + codeName + " | URL: " + currentUrl + " | MIME: " + currentMimeType);

                boolean isContainerError = codeName != null && codeName.contains("PARSING_CONTAINER_UNSUPPORTED");
                boolean isConnectionError = codeName != null
                    && (codeName.contains("IO_CONNECTION")
                    || codeName.contains("IO_NETWORK_CONNECTION")
                    || codeName.contains("IO_BAD_HTTP_STATUS"));

                if (isContainerError) {
                    if (!retriedWithoutMime && currentMimeType != null && !currentMimeType.trim().isEmpty()) {
                        retriedWithoutMime = true;
                        android.util.Log.d("NativeVideo", "Retry 1: Trying without forced MIME type...");
                        showStatusOverlay("Trying auto-detected format", 2200);
                        preparePlayback(currentUrl, null);
                        return;
                    }

                    if (allowLiveFallback && !retriedDirectStream && currentUrl != null && currentUrl.contains("/play/stream/channel/")) {
                        retriedDirectStream = true;
                        String liveUrl = currentUrl.replace("/play/stream/channel/", "/stream/channel/");
                        android.util.Log.d("NativeVideo", "Retry 2: Trying direct stream endpoint: " + liveUrl);
                        showStatusOverlay("Trying live stream fallback", 2200);
                        preparePlayback(liveUrl, null);
                        return;
                    }

                    if (mimeTypeRetryCount == 0 && !MimeTypes.VIDEO_MP2T.equals(currentMimeType)) {
                        mimeTypeRetryCount = 1;
                        android.util.Log.d("NativeVideo", "Retry 3: Trying mp2t MIME type...");
                        showStatusOverlay("Trying MPEG-TS decoder path", 2200);
                        preparePlayback(currentUrl, MimeTypes.VIDEO_MP2T);
                        return;
                    }

                    if (mimeTypeRetryCount == 1 && !MimeTypes.VIDEO_MATROSKA.equals(currentMimeType)) {
                        mimeTypeRetryCount = 2;
                        android.util.Log.d("NativeVideo", "Retry 4: Trying matroska MIME type...");
                        showStatusOverlay("Trying Matroska decoder path", 2200);
                        preparePlayback(currentUrl, MimeTypes.VIDEO_MATROSKA);
                        return;
                    }

                    if (tryNextProfile()) {
                        return;
                    }
                }

                if (isConnectionError) {
                    if (allowLiveFallback && !retriedDirectStream && currentUrl != null && currentUrl.contains("/play/stream/channel/")) {
                        retriedDirectStream = true;
                        String liveUrl = currentUrl.replace("/play/stream/channel/", "/stream/channel/");
                        android.util.Log.d("NativeVideo", "Retry IO: Trying live stream endpoint: " + liveUrl);
                        showStatusOverlay("Trying live stream fallback", 2200);
                        preparePlayback(liveUrl, currentMimeType);
                        return;
                    }

                    if (tryNextProfile()) {
                        return;
                    }
                }

                android.util.Log.e("NativeVideo", "Playback failed after all retries: " + codeName);
                showStatusOverlay("Playback failed", 2600);
                Toast.makeText(NativeVideoActivity.this, "Playback error: " + codeName, Toast.LENGTH_LONG).show();
            }
        });

        MediaItem.Builder mediaItemBuilder = new MediaItem.Builder().setUri(Uri.parse(url));
        if (mimeType != null && !mimeType.trim().isEmpty()) {
            mediaItemBuilder.setMimeType(mimeType);
        }

        player.setMediaItem(mediaItemBuilder.build());
        player.prepare();
        player.play();
    }

    private String normalizeMimeType(String mimeType, String url) {
        if (mimeType != null && !mimeType.trim().isEmpty()) {
            return mimeType;
        }

        String source = url == null ? "" : url.toLowerCase();
        if (source.contains("matroska")) {
            return MimeTypes.VIDEO_MATROSKA;
        }
        if (source.contains("mpegts")) {
            return MimeTypes.VIDEO_MP2T;
        }
        return null;
    }

    private boolean isDirectionalKey(int keyCode) {
        return keyCode == KeyEvent.KEYCODE_DPAD_UP
            || keyCode == KeyEvent.KEYCODE_DPAD_DOWN
            || keyCode == KeyEvent.KEYCODE_DPAD_LEFT
            || keyCode == KeyEvent.KEYCODE_DPAD_RIGHT;
    }

    private boolean surfChannel(int direction) {
        if (direction == 0) {
            return false;
        }

        long now = System.currentTimeMillis();
        if (now - lastChannelSurfAtMs < 250L) {
            return true;
        }

        if (liveChannels.isEmpty()) {
            showStatusOverlay("Channel list unavailable", 1800);
            return true;
        }

        int currentIndex = -1;
        for (int index = 0; index < liveChannels.size(); index += 1) {
            LiveChannelEntry channel = liveChannels.get(index);
            if (channel.uuid.equals(currentChannelId)) {
                currentIndex = index;
                break;
            }
        }

        if (currentIndex < 0) {
            currentIndex = 0;
        }

        int nextIndex = (currentIndex + direction + liveChannels.size()) % liveChannels.size();
        LiveChannelEntry nextChannel = liveChannels.get(nextIndex);
        if (nextChannel == null || nextChannel.uuid.isEmpty() || nextChannel.uuid.equals(currentChannelId)) {
            return true;
        }

        String nextUrl = replaceChannelIdInUrl(currentUrl, nextChannel.uuid);
        if (nextUrl == null || nextUrl.trim().isEmpty()) {
            showStatusOverlay("Unable to switch channel", 1800);
            return true;
        }

        lastChannelSurfAtMs = now;
        currentChannelId = nextChannel.uuid;
        currentUrl = nextUrl;
        programTitle = "";
        programTime = "";
        programDescription = "";
        programCategory = "";
        setTitle(nextChannel.name.isEmpty() ? "Live TV" : nextChannel.name);
        showProgramInfoOverlay();
        showStatusOverlay("Switching to " + (nextChannel.name.isEmpty() ? nextChannel.uuid : nextChannel.name), 1800);

        retriedWithoutMime = false;
        retriedDirectStream = false;
        mimeTypeRetryCount = 0;
        preparePlayback(nextUrl, currentMimeType);
        return true;
    }

    private boolean togglePlayback() {
        if (player == null) {
            return false;
        }

        boolean playWhenReady = !player.getPlayWhenReady();
        player.setPlayWhenReady(playWhenReady);

        if (playerView != null) {
            playerView.requestFocus();
            playerView.showController();
        }

        showStatusOverlay(playWhenReady ? "Playing" : "Paused", 1400);

        return true;
    }

    private boolean setPlayWhenReady(boolean playWhenReady) {
        if (player == null) {
            return false;
        }

        player.setPlayWhenReady(playWhenReady);

        if (playerView != null) {
            playerView.requestFocus();
            playerView.showController();
        }

        showStatusOverlay(playWhenReady ? "Playing" : "Paused", 1400);

        return true;
    }

    private boolean tryNextProfile() {
        if (fallbackProfiles.isEmpty() || activeProfileIndex >= fallbackProfiles.size() - 1) {
            return false;
        }

        activeProfileIndex += 1;
        String nextProfile = fallbackProfiles.get(activeProfileIndex);
        String nextUrl = withProfile(currentUrl, nextProfile);
        String nextMimeType = resolveMimeTypeForProfile(nextProfile);

        android.util.Log.d("NativeVideo", "Retry 5: Trying fallback profile " + nextProfile + "...");
        showStatusOverlay("Trying " + formatProfileLabel(nextProfile), 2400);

        retriedWithoutMime = false;
        retriedDirectStream = false;
        mimeTypeRetryCount = 0;
        preparePlayback(nextUrl, nextMimeType);
        return true;
    }

    private List<String> parseFallbackProfiles(String csv) {
        List<String> profiles = new ArrayList<>();
        if (csv == null || csv.trim().isEmpty()) {
            return profiles;
        }

        String[] parts = csv.split(",");
        for (String part : parts) {
            String profile = part == null ? "" : part.trim();
            if (!profile.isEmpty() && !profiles.contains(profile)) {
                profiles.add(profile);
            }
        }

        return profiles;
    }

    private int resolveActiveProfileIndex(String url, List<String> profiles) {
        String profile = extractProfile(url);
        if (profile.isEmpty()) {
            return 0;
        }

        int index = profiles.indexOf(profile);
        return index >= 0 ? index : 0;
    }

    private String extractProfile(String url) {
        if (url == null || url.trim().isEmpty()) {
            return "";
        }

        try {
            Uri uri = Uri.parse(url);
            String profile = uri.getQueryParameter("profile");
            return profile == null ? "" : profile.trim();
        } catch (Exception ignored) {
            return "";
        }
    }

    private String withProfile(String url, String profile) {
        if (url == null || url.trim().isEmpty() || profile == null || profile.trim().isEmpty()) {
            return url;
        }

        Uri uri = Uri.parse(url);
        Uri.Builder builder = uri.buildUpon().clearQuery();
        for (String name : uri.getQueryParameterNames()) {
            if (!"profile".equals(name)) {
                for (String value : uri.getQueryParameters(name)) {
                    builder.appendQueryParameter(name, value);
                }
            }
        }
        builder.appendQueryParameter("profile", profile);
        return builder.build().toString();
    }

    private String resolveMimeTypeForProfile(String profile) {
        String normalizedProfile = profile == null ? "" : profile.toLowerCase();
        if (normalizedProfile.contains("matroska")) {
            return MimeTypes.VIDEO_MATROSKA;
        }
        if (normalizedProfile.contains("mpegts") || "pass".equals(normalizedProfile)) {
            return MimeTypes.VIDEO_MP2T;
        }
        return MimeTypes.VIDEO_MP4;
    }

    private String getActiveProfileLabel() {
        if (activeProfileIndex >= 0 && activeProfileIndex < fallbackProfiles.size()) {
            return fallbackProfiles.get(activeProfileIndex);
        }
        return extractProfile(currentUrl);
    }

    private String formatProfileLabel(String profile) {
        String normalizedProfile = profile == null ? "" : profile.trim();
        if (normalizedProfile.isEmpty()) {
            return "stream";
        }
        if ("pass".equalsIgnoreCase(normalizedProfile)) {
            return "original stream";
        }
        return normalizedProfile
            .replace("webtv-", "")
            .replace('-', ' ')
            .trim();
    }

    private void showStatusOverlay(String message, int durationMs) {
        if (statusOverlay == null) {
            return;
        }

        statusOverlay.setText(message);
        statusOverlay.setVisibility(View.VISIBLE);
        overlayHandler.removeCallbacks(hideOverlayRunnable);
        if (durationMs > 0) {
            overlayHandler.postDelayed(hideOverlayRunnable, durationMs);
        }
    }

    private void showProgramInfoOverlay() {
        if (programInfoOverlay == null || programTitleView == null || programMetaView == null || programDescriptionView == null) {
            return;
        }

        overlayHandler.removeCallbacks(hideProgramInfoOverlayRunnable);

        boolean hasProgramInfo = !programTitle.isEmpty() || !programTime.isEmpty() || !programCategory.isEmpty() || !programDescription.isEmpty();
        if (!hasProgramInfo) {
            programInfoOverlay.setVisibility(View.GONE);
            return;
        }

        programInfoOverlay.setVisibility(View.VISIBLE);
        programTitleView.setText(programTitle.isEmpty() ? getTitle() : programTitle);

        StringBuilder meta = new StringBuilder();
        if (!programTime.isEmpty()) {
            meta.append(programTime);
        }
        if (!programCategory.isEmpty()) {
            if (meta.length() > 0) {
                meta.append("  •  ");
            }
            meta.append(programCategory);
        }
        programMetaView.setText(meta.toString());
        programMetaView.setVisibility(meta.length() > 0 ? View.VISIBLE : View.GONE);

        programDescriptionView.setText(programDescription);
        programDescriptionView.setVisibility(programDescription.isEmpty() ? View.GONE : View.VISIBLE);
        overlayHandler.postDelayed(hideProgramInfoOverlayRunnable, PROGRAM_INFO_TIMEOUT_MS);
    }

    private boolean finishToReturnTarget() {
        if (!returnTo.startsWith("/")) {
            return false;
        }

        Intent intent = new Intent(this, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        intent.putExtra(EXTRA_RETURN_TO, returnTo);
        if (!returnToken.isEmpty()) {
            intent.putExtra(EXTRA_RETURN_TOKEN, returnToken);
        }
        if (!currentChannelId.isEmpty()) {
            intent.putExtra(EXTRA_RETURN_CHANNEL_ID, currentChannelId);
        }
        startActivity(intent);
        finish();
        return true;
    }

    private List<LiveChannelEntry> parseLiveChannels(String json) {
        List<LiveChannelEntry> parsed = new ArrayList<>();
        if (json == null || json.trim().isEmpty()) {
            return parsed;
        }

        try {
            JSONArray items = new JSONArray(json);
            for (int index = 0; index < items.length(); index += 1) {
                JSONObject item = items.optJSONObject(index);
                if (item == null) {
                    continue;
                }

                String uuid = normalizeValue(item.optString("uuid", ""));
                if (uuid.isEmpty()) {
                    continue;
                }

                String name = normalizeValue(item.optString("name", ""));
                parsed.add(new LiveChannelEntry(uuid, name));
            }
        } catch (Exception error) {
            android.util.Log.w("NativeVideo", "Failed to parse live channel list: " + error.getMessage());
        }

        return parsed;
    }

    private String replaceChannelIdInUrl(String url, String nextChannelId) {
        if (url == null || url.trim().isEmpty() || nextChannelId == null || nextChannelId.trim().isEmpty()) {
            return url;
        }

        return url.replaceFirst("(/channel/)[^/?]+", "$1" + nextChannelId.trim());
    }

    private String normalizeValue(String value) {
        return value == null ? "" : value.trim();
    }
}