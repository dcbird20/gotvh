# GoTVH for Android TV / Google TV


**Two apps, one codebase.** `tv` (src/tv) is the Google TV / Android TV app below. `mobile` (src/mobile)
is the phone and tablet app: Live TV with pause, a tap-to-record guide, and Recordings with resume and
watched state, all shared with the TV. Install it from `http://raven1:8090/phone` (home Wi-Fi only
for now). Both share src/main: the Tvheadend client, HTSP, the player and the view model.

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

## Search

Menu → Search (TV) or the 🔍 in the phone app's top bar: searches the whole guide (titles, episode
names and descriptions) and your recordings as you type. On the TV, OK on the box opens the keyboard
(its microphone works too); Down moves into the results. OK / tap: on now → watch; later → Record /
Record series; a recording → play.

## Pausing live TV

Live TV comes over HTSP, Tvheadend's own protocol (the one Kodi uses), on the port after the web
interface's (9981 → 9982). Pausing and rewinding use Tvheadend's timeshift buffer, so its settings
apply (Configuration → Recording → Timeshift: how long and how much disk) and it keeps recording
while you're paused. The account needs the HTSP streaming right. If HTSP can't be reached, or a
channel needs converting for the TV, it plays over HTTP as before, without pause; the banner says so.

Recordings still being made appear under Recorded (● recording) and play from the start, following
the file as it grows.

## Remote

**Watching**

| Key | Does |
|---|---|
| Up / Ch+ · Down / Ch− | Next / previous channel |
| OK | Pause (a channel that can't pause: info banner; OK again: channel list) |
| ⏯ ⏪ ⏩ (if the remote has them) | Pause / play, back, forward, any time |

**Paused or behind live** the playback bar takes over:

| Key | Does |
|---|---|
| OK | Play / pause |
| Left / Right | Back 10 s / forward 30 s (forward past live goes back to live) |
| Down | The bar's buttons: Guide · Channels · Recordings · Search · Record · Live (Left/Right to choose, OK to open, Up or Back to leave) |
| Down again | The mini guide: Left/Right to an upcoming programme, OK for Record / Record series |

Record records the programme on screen (from now: Tvheadend can't add what's already gone by).
The bar clears after 5 seconds without a key press, paused or not; a corner badge then shows paused /
time behind live for a few seconds.
| Left | Channel list (Up/Down, OK to tune, Right for its guide) |
| Right / Guide | Guide |
| Back (or Menu) | Closes what's open, then the menu: Live TV, Guide, Search, Recordings, Auto-record rules, Settings, Exit |
| 0–9 | Type a channel number |
| Last channel | Back to the previous channel |

**Guide** (drawn over the channel you're watching)

| Key | Does |
|---|---|
| Left / Right | Previous / next programme; scrolls at the edges |
| Up / Down | Channel above / below, same time of day |
| Ch+ / Ch− | A page of channels |
| ⏪ / ⏩ | Two hours back / ahead |
| OK | On now: watch it. Later: its details (Record, Record series, Don't record) |
| Hold OK | Details for any programme: description, Watch, Record, Record series |
| ▶ | Watch that channel |
| Back / Guide | Back to TV |

**Recordings** (Back → Recordings)

| Key | Does |
|---|---|
| Up / Down | Move; Up at the top reaches the Recorded / Upcoming tabs |
| OK | A show: its recordings (a show with one recording plays it). A recording: play, resuming where you stopped |
| Right | Options: Resume / Play from start, Mark watched / unwatched, Delete |
| Left / Back | Back to the shows, then TV |
| OK (Upcoming) | Don't record / Stop recording |

"Continue watching" at the top lists everything stopped partway. Each recording shows a dot when
it's new, a progress bar and time left when it's in progress, and ✓ (dimmed) when watched.

**Playing a recording** uses the same bar as live TV: OK/⏯ pause · Left/⏪ back 10 s · Right/⏩ forward
30 s · Down for Guide · Channels · Recordings · Search · Restart. The recording keeps playing behind the
guide, recordings and search, and Back there comes back to it. Back hides the bar, then leaves (where you
stopped is saved).

**Back** always goes one step back and never stops anything: from the guide, recordings, search or the
rules it returns to whatever is playing (the recording, or live TV).

The first 15 s of a recording don't count; the last minute counts as watched. Watched state and the
resume point are stored on the recording in Tvheadend (the same fields Kodi uses), so every TV picks up
where you stopped.

**Auto-record rules** (Back → Auto-record rules): OK to switch a rule on or off, or delete it.
Creating and editing rules is in the guide (Record series) and the admin app.

Google TV remotes have no Menu key, so Back from full-screen TV opens the menu; Home leaves the app.

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
