package io.gotvh.app;

import android.net.Uri;
import android.os.Bundle;
import android.widget.Toast;

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

import java.util.HashMap;
import java.util.Map;

public class NativeVideoActivity extends AppCompatActivity {
    public static final String EXTRA_URL = "streamUrl";
    public static final String EXTRA_TITLE = "streamTitle";
    public static final String EXTRA_MIME_TYPE = "streamMimeType";
    public static final String EXTRA_AUTH_HEADER = "streamAuthHeader";
    public static final String EXTRA_ALLOW_LIVE_FALLBACK = "allowLiveFallback";

    private ExoPlayer player;
    private PlayerView playerView;
    private String currentUrl;
    private String currentMimeType;
    private String authHeader;
    private boolean allowLiveFallback;
    private boolean retriedWithoutMime;
    private boolean retriedDirectStream;
    private int mimeTypeRetryCount = 0;

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_native_video);

        playerView = findViewById(R.id.native_player_view);

        String url = getIntent().getStringExtra(EXTRA_URL);
        String title = getIntent().getStringExtra(EXTRA_TITLE);
        String mimeType = normalizeMimeType(getIntent().getStringExtra(EXTRA_MIME_TYPE), url);
        authHeader = getIntent().getStringExtra(EXTRA_AUTH_HEADER);
        allowLiveFallback = getIntent().getBooleanExtra(EXTRA_ALLOW_LIVE_FALLBACK, false);

        if (title != null && !title.trim().isEmpty()) {
            setTitle(title);
        }

        if (url == null || url.trim().isEmpty()) {
            Toast.makeText(this, "Missing stream URL", Toast.LENGTH_LONG).show();
            finish();
            return;
        }

        android.util.Log.d("NativeVideo", "Loading stream: " + url + " | mimeType: " + mimeType + " | auth: " + (authHeader != null ? "yes" : "no"));

        playerView.setUseController(true);

        retriedWithoutMime = false;
        retriedDirectStream = false;
        mimeTypeRetryCount = 0;
        preparePlayback(url, mimeType);
    }

    @Override
    protected void onStop() {
        super.onStop();
        if (player != null) {
            player.release();
            player = null;
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
                    if (!seekable && duration > 0) {
                        android.util.Log.w("NativeVideo", "Stream marked as non-seekable but has duration - this may be a buffered stream");
                    }
                }
            }

            @Override
            public void onPlayerError(PlaybackException error) {
                String codeName = error.getErrorCodeName();
                android.util.Log.w("NativeVideo", "Playback error: " + codeName + " | URL: " + currentUrl + " | MIME: " + currentMimeType);

                if (codeName != null && codeName.contains("PARSING_CONTAINER_UNSUPPORTED")) {
                    if (!retriedWithoutMime && currentMimeType != null && !currentMimeType.trim().isEmpty()) {
                        retriedWithoutMime = true;
                        android.util.Log.d("NativeVideo", "Retry 1: Trying without forced MIME type...");
                        preparePlayback(currentUrl, null);
                        return;
                    }

                    if (allowLiveFallback && !retriedDirectStream && currentUrl != null && currentUrl.contains("/play/stream/channel/")) {
                        retriedDirectStream = true;
                        String liveUrl = currentUrl.replace("/play/stream/channel/", "/stream/channel/");
                        android.util.Log.d("NativeVideo", "Retry 2: Trying direct stream endpoint: " + liveUrl);
                        preparePlayback(liveUrl, null);
                        return;
                    }

                    if (mimeTypeRetryCount == 0 && !MimeTypes.VIDEO_MP2T.equals(currentMimeType)) {
                        mimeTypeRetryCount = 1;
                        android.util.Log.d("NativeVideo", "Retry 3: Trying mp2t MIME type...");
                        preparePlayback(currentUrl, MimeTypes.VIDEO_MP2T);
                        return;
                    }

                    if (mimeTypeRetryCount == 1 && !MimeTypes.VIDEO_MATROSKA.equals(currentMimeType)) {
                        mimeTypeRetryCount = 2;
                        android.util.Log.d("NativeVideo", "Retry 4: Trying matroska MIME type...");
                        preparePlayback(currentUrl, MimeTypes.VIDEO_MATROSKA);
                        return;
                    }
                }

                android.util.Log.e("NativeVideo", "Playback failed after all retries: " + codeName);
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
}