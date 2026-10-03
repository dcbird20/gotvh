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

Menu → Search (TV) or the 🔍 in the phone app's top bar: searches the guide and your recordings as
you type — titles, episode names and descriptions (a game titled "College Football" is found by
"Penn State"; the matching words show under it). Switch off **Include descriptions** (remembered) to
search titles only. On the TV, OK on the box opens the keyboard (its microphone works too); Down reaches
the switch, then the results. OK on a result opens its card.

## Pausing live TV

Live TV comes over HTSP, Tvheadend's own protocol (the one Kodi uses), on the port after the web
interface's (9981 → 9982). Pausing and rewinding use Tvheadend's timeshift buffer, so its settings
apply (Configuration → Recording → Timeshift: how long and how much disk) and it keeps recording
while you're paused. The account needs the HTSP streaming right. If HTSP can't be reached, or a
channel needs converting for the TV, it plays over HTTP as before, without pause; the banner says so.

Recordings still being made appear under Recorded (● recording) and play from the start, following
the file as it grows.

## Remote

Built for any Google TV remote: the arrows, OK and Back are all you need. Everywhere, the arrows move
a visible highlight, OK presses it and Back goes one step back. Nothing needs a long press, and no key
changes meaning on a timer. ⏯ ⏪ ⏩, Guide and Ch± keys work too on remotes that have them.

**Watching** (live TV or a recording), nothing on screen — these never change:

| Key | Does |
|---|---|
| OK | The player controls |
| Left / Right | Tap: back 10 s / forward 30 s (live TV: into Tvheadend's pause buffer; forward stops at live) |
| Hold Left / Right | Rewind / fast-forward at 2×. Then Right / Left: faster / slower (2× 4× 8× 16× 32×; slowing below 2× switches direction), OK plays from there, Back returns to where you started |
| Up / Down | Next / previous channel (live TV); on a recording, the controls |
| Back | Live TV: the menu. A recording: back to Recordings (where you stopped is saved) |
| 0–9 (or the TV's 123 pad) | A channel number |

**The player controls** (the same for live TV and recordings): what's playing, a progress row, and a
row of buttons — ⏯ · Info · CC · Guide · Channels · 123 · Recordings · Search · Record (live TV; · Live when
behind) or Restart (a recording). The highlight starts on ⏯, so OK, OK pauses. Up moves to the progress
row, where Left/Right go back / forward. On live TV, Down reaches the mini guide (OK on a programme: its
card). 123 opens an on-screen number pad. The controls close after 8 seconds without a key press, and
Back closes them. Whatever is playing keeps playing behind the guide, recordings and search; Back there
comes back to it.

**Closed captions**: CC in the controls (or a remote's Captions key) turns them on or off for live TV
and recordings; the choice is remembered. Until you choose, the app follows the TV's own Captions
setting (Accessibility), which also sets their size and style. These are the US broadcast captions
(CEA-608) carried inside the video. DVB subtitles and teletext (European broadcasts) aren't shown yet.

**One details card** for every programme and recording — from the guide, search, the mini guide, Info
or Recordings: the description, and the most likely action first (Watch for something on now, Record
for later, Resume or Play for a recording), so OK, OK does the obvious thing.

**Guide** (drawn over the channel you're watching)

| Key | Does |
|---|---|
| Left / Right | Previous / next programme; scrolls at the edges |
| Up / Down | Channel above / below, same time of day |
| Ch+ / Ch− | A page of channels |
| ⏪ / ⏩ | Two hours back / ahead |
| OK | The programme's card: Watch, Record, Record series |
| ▶ | Watch that channel |
| Back | Back to what's playing |

**Genres**: Up from the top channel moves to the genre chips (All · Sports · Movies · …). Left/Right pick
one: the guide then lists only channels with that genre in the next 12 hours and fades other
programmes. Down, OK or Back returns to the grid; the choice is kept until you change it.

**Recordings**: Up/Down move; OK on a show lists its recordings, OK on a recording opens its card
(Resume / Play, From the start, Mark watched / unwatched, Delete or Stop recording); Back goes up a level,
then back to what's playing. "Continue watching" at the top lists everything stopped partway; a dot means
new, a bar and time left in progress, ✓ watched. Watched state and the resume point are stored on the
recording in Tvheadend (the same fields Kodi uses), so every device picks up where you stopped.

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

## Away from home

Settings → **Away from home**: pair the device once, at home, with a code from the admin app
(Devices → Pair a device). From then on the app uses the home address when it answers and the
server's away address otherwise (HTTPS and HTSP over TLS, with this device's certificate), asking
Tvheadend for a smaller stream (the "Away quality" profile, `webtv-h264-aac-mpegts` by default).
Server side: `remote/` and docs/remote-access.md.
