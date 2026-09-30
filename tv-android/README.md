# GoTVH for Android TV / Google TV

A native TV app for Tvheadend: live TV, a full guide, and recording. Kotlin, Jetpack Compose and
Media3 (ExoPlayer, the player most Android TV apps use). Setup and fixing stay in the GoTVH admin
web app; this app is for watching.

## Install

Every push builds an APK on GitHub. The newest one is always at:

    https://github.com/dcbird20/gotvh/releases/download/tv-latest/gotvh-tv.apk

On the home network there's a short address for typing on a remote (raven1's nginx redirects it
to the link above):

    192.168.1.72:8090/tv

On the TV:
1. Settings → Device Preferences → Security & restrictions → allow installing from unknown sources
   for the app you'll use to download (e.g. **Downloader** by AFTVnews, free in the Play Store).
2. In Downloader, open `192.168.1.72:8090/tv` (or the full address) and install.
3. Updates install over the previous version (every build is signed with the same key).

First start asks for the Tvheadend address (e.g. `http://192.168.1.222:9981`) and account — the
same as the admin web app. The account needs web interface and streaming rights. Basic and Digest
sign-in both work.

## Remote

**Watching**

| Key | Does |
|---|---|
| Up / Ch+ · Down / Ch− | Next / previous channel |
| OK | Info banner: now with progress, and the next few programmes; OK again: channel list |
| Left | Channel list (Up/Down, OK to tune, Right for its guide) |
| Right / Guide | Guide |
| Menu | Menu: Live TV, Guide, Recordings, Auto-record rules, Settings |
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
| Menu | Menu |
| Back / Guide | Back to TV |

**Recordings** (Menu → Recordings)

| Key | Does |
|---|---|
| Up / Down | Move; Up at the top reaches the Recorded / Upcoming tabs |
| Right / OK | A show's episodes; OK on an episode: Resume, Play from start, Delete |
| OK (Upcoming) | Don't record / Stop recording |
| Back | Shows, then TV |

**Playing a recording**: Left/⏪ back 10 s · Right/⏩ forward 30 s · OK/⏯ pause · Back to Recordings.
It remembers where you stopped and offers to resume.

**Auto-record rules** (Menu → Auto-record rules): OK to switch a rule on or off, or delete it.
Creating and editing rules is in the guide (Record series) and the admin app.

## Playback

Streams use the `pass` profile (the broadcast as-is). Dolby AC-3 / E-AC-3 sound is decoded in
software (FFmpeg) on TVs that can't decode it themselves. If the TV can't decode a channel's
picture — antenna channels are often MPEG-2 — the app switches to a converting profile
on the server (any profile with h264 in its name). If Tvheadend has none, add one under
Configuration → Stream → Stream profiles (e.g. a *Transcode/av-lib* profile producing H.264/AAC in
MPEG-TS) and the app uses it automatically.

## Build locally

Open `tv-android/` in Android Studio, or `./gradlew assembleDebug`. The debug key
(`app/debug.keystore`) is checked in on purpose so GitHub builds can update each other; it's not a
secret and isn't for store releases.
