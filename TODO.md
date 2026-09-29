# GoTVH admin — TODO

Working list for the admin app (`projects/gotvh-admin`). Most-basic first.

## Basics still missing

All basics are done — see below.

## Setup without system knowledge

The stock UI needs you to know the chain
`tuner → network → mux → service → (map) → channel → (EPG match) → guide data`.

- [x] **Map services screen** — unmapped services by network, editable names/numbers from the
      broadcast, TV/radio/data defaults, one channel per name across networks, adds to
      existing channels, number clashes flagged, then guide data.
- [x] **Linked screens** (Connected to card on Channels and Tuners & networks): a "Connected to" panel in every editor with click-through links
      (channel → service → mux → network → tuner, EPG source; network → mux/service counts,
      services not yet mapped).
- [x] **IPTV channel names** — Map services names streams from the playlist and can shorten
      "PA | Johnstown | ABC WATM" → "ABC WATM"; Channels offers "Fix names…" for existing
      "Service01" channels and long names; README explains the FFmpeg fix at the source.
- [x] **More Connected to links** — recordings (channel chain, rule/timer, DVR profile), guide channels
      (channels they feed), channel tags (channels, rules, users); ?open= deep links on Auto-record,
      Timers, DVR profiles and EPG channels.
- [x] **Guided "Add a source"** — antenna/cable/satellite (tuners → new or existing network
      with region frequencies → scan with progress) or IPTV playlist (automatic network,
      stream limit) → Map services → guide data.

## Antenna / HDHomeRun

- [x] **Antenna first, IPTV as backup** — broadcast tuners raised above IPTV networks (Add a source,
      Map services, or "Use the antenna first" from a channel's Connected to card, which shows the order).
- [x] **Local IP / Local port** for HDHomeRun behind Docker or a VPN — in Add a source's HDHomeRun step,
      with the UDP ports to forward.
- [x] **Channel health** — Channels flags enabled channels with nothing to play (feed deleted, switched
      off, or none), finds the same station's working feeds (call sign, or number + network), relinks them
      antenna first, removes the disabled duplicates, then plays each repaired channel to prove it.
- [x] **Test playback** — plays a channel for a few seconds; when nothing arrives, compares with another
      channel on the same source and says whether the stream or the whole source is dead.
- [x] **Let the HDHomeRun manage its tuners** — one click on Tuners & networks moves channels from native
      tuners to the device's own lineup.m3u streams (matched by channel number), puts that source first, and
      switches the native tuners and network off. Linked from Live status when tuners are held.
- [x] **Tuners held by another app** — Tvheadend retries a locked HDHomeRun tuner forever instead of
      using a free one or the IPTV fallback. Test playback, channel repair and Live status switch held
      tuners off in Tvheadend and back on once free.
- [x] **Live status: receiving nothing** — streams and recordings with no data for 20 s are flagged with
      the likely cause and a link to the channel.
- [x] **Tuner health during scans** — a tuner that locks but delivers no video is named, with the cause
      (e.g. HDHomeRun sending to an unreachable container address).
- [x] **No duplicate networks** — Add a source suggests rescanning the network the tuners already have;
      new networks are named after their frequency list.
- [x] **Over-the-air guide** — Map services switches on the ATSC PSIP / DVB EIT grabber and starts a grab
      when it maps broadcast channels.

- [x] Retry empty frequencies after a scan; Scan on selected muxes.
- [ ] **Shared HDHomeRun** — Tvheadend marks a mux FAIL at once when a tuner's lock is held by
      another client (`failed to acquire lockkey`), rather than trying another tuner. Options: give each
      server its own tuners; point the other server's playlist at specific tuners; or patch Tvheadend to
      return "no free adapter" so the scan requeues.

## Guide

- [x] Guide grid (channels × time, 4 hours at a time, days, tag filter, search) with Record,
      Record series / every showing, Don't record, and Watch in VLC (ticketed .m3u).
- [ ] Watch in the browser (needs an H.264/AAC transcoding stream profile + a web player).
- [ ] Clash warnings when scheduling (more recordings than tuners at that time).

## Housekeeping

- [ ] Test every screen against the real server (built and tested against mocks so far).
      Try risky changes (stream/codec profiles, users) on a second Tvheadend instance first.
- [x] nginx site for raven1 (`scripts/deploy-admin.sh`): ports 8090 (raven1) and 8091 (omv-dell),
      Tvheadend passed through, `/hdhr/` proxy for the tuner check.
- [ ] Switch the TV app's auto-record screen to the shared helpers in
      `projects/tvh-api/src/autorec-rules.ts`.
- [ ] Upgrade Angular 19 → 21 on its own branch (clears most `npm audit` findings).
- [ ] `npm audit fix` (non-breaking) for build-tool advisories.

## Done

- [x] Merged `admin-workspace` into `main` (old main kept as branch `main-before-admin`)
- [x] Admin app scaffold, shared API library, desktop layout
- [x] Live status (tuner signal/SNR/errors with rising-error warning, streams, clients; stop recording, disconnect)
- [x] Dashboard (read-only), Recordings (bulk cancel / delete / watched)
- [x] Recordings part 2: side panel (details, why it failed with next steps, edit times/padding/title), stop, download, record next airing, keep anyway; new one-off recording; Timers screen
- [x] Add a mux by hand (per network type) and Map services to channels (options explained, progress)
- [x] Auto-record rules (full editor, bulk enable/disable/delete)
- [x] DVR profiles (metadata-driven editor)
- [x] Tuners & networks (tuner tree, networks, muxes, services)
- [x] Channels (filters, EPG source column, bulk edit)
- [x] EPG sources (grabbers, settings incl. cron, EPG channels, map by name)
- [x] Users & access (users joined with passwords, roles, lockout guards, blocked networks)
- [x] Channel tags (channel counts, order, hidden/private, what limits them, link to Channels)
- [x] Stream profiles (types in plain English, used-by, default, codec profiles for transcoding)
- [x] Multi-select + bulk actions + bulk edit (add/remove/replace for lists) everywhere
