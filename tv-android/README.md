# GoTVH for Android TV / Google TV

A native TV app for Tvheadend: live TV, a full guide, and recording. Kotlin, Jetpack Compose and
Media3 (ExoPlayer, the player most Android TV apps use). Setup and fixing stay in the GoTVH admin
web app; this app is for watching.

## Install

Every push builds an APK on GitHub. The newest one is always at:

    https://github.com/dcbird20/gotvh/releases/download/tv-latest/gotvh-tv.apk

On the TV:
1. Settings → Device Preferences → Security & restrictions → allow installing from unknown sources
   for the app you'll use to download (e.g. **Downloader** by AFTVnews, free in the Play Store).
2. In Downloader, open the address above and install.
3. Updates install over the previous version (every build is signed with the same key).

First start asks for the Tvheadend address (e.g. `http://192.168.1.222:9981`) and account — the
same as the admin web app. The account needs web interface and streaming rights, and Tvheadend
must accept plain (Basic) sign-in.

## Remote

**Watching**

| Key | Does |
|---|---|
| Up / Ch+ · Down / Ch− | Next / previous channel |
| OK | Info banner (now, next, progress); OK again: channel list |
| Left | Channel list (Up/Down, OK to tune, Right for its guide) |
| Right / Guide / Menu | Guide |
| 0–9 | Type a channel number |
| Last channel | Back to the previous channel |
| Back | Close what's open; twice to exit |

**Guide** (drawn over the channel you're watching)

| Key | Does |
|---|---|
| Left / Right | Previous / next programme; scrolls at the edges |
| Up / Down | Channel above / below, same time of day |
| Ch+ / Ch− | A page of channels |
| ⏪ / ⏩ | Two hours back / ahead |
| OK | Details: Watch, Record, Record series, Don't record |
| ▶ | Watch that channel |
| Menu | Settings (server and sign-in) |
| Back / Guide | Back to TV |

## Playback

Streams use the `pass` profile (the broadcast as-is). If the TV can't decode a channel — antenna
channels are often MPEG-2 video with Dolby AC-3 sound — the app switches to a converting profile
on the server (any profile with h264 in its name). If Tvheadend has none, add one under
Configuration → Stream → Stream profiles (e.g. a *Transcode/av-lib* profile producing H.264/AAC in
MPEG-TS) and the app uses it automatically.

## Build locally

Open `tv-android/` in Android Studio, or `./gradlew assembleDebug`. The debug key
(`app/debug.keystore`) is checked in on purpose so GitHub builds can update each other; it's not a
secret and isn't for store releases.
