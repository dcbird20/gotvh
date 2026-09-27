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
- [ ] **IPTV channel names** — streams passed through FFmpeg all call themselves
      "Service01" (provider "FFmpeg"); Map services already names them from the playlist.
  - [ ] "Shorten names" option on Map services: keep the last part of names like
        `PA | Johnstown | ABC WATM` → `ABC WATM` (split on ` | `).
  - [ ] Find existing channels still named after placeholders (Service01, Program 3) and
        offer to rename them from their playlist entry (on Channels).
  - [ ] Note in the docs: fix at the source with `-metadata service_name="…"` on the FFmpeg
        command (pipe:// entries or the IPTV proxy) so Tvheadend gets real names too.
- [ ] **More Connected to links** — recordings (→ channel → … → tuner), EPG channels
      (→ channels they feed), channel tags (→ their channels).
- [x] **Guided "Add a source"** — antenna/cable/satellite (tuners → new or existing network
      with region frequencies → scan with progress) or IPTV playlist (automatic network,
      stream limit) → Map services → guide data.

## Antenna / HDHomeRun

- [ ] **Priority for fallback channels** — when Map services merges antenna + IPTV, set the antenna
      tuners' priority higher (Tvheadend input `priority`) so IPTV is only the fallback.
- [ ] **Local IP / Local port** for HDHomeRun behind Docker or a VPN — expose these hidden settings in
      Add a source (they fixed omv-dell behind NordLynx: UDP base port + one per tuner).
- [x] **Over-the-air guide** — Map services switches on the ATSC PSIP / DVB EIT grabber and starts a grab
      when it maps broadcast channels.

- [x] Retry empty frequencies after a scan; Scan on selected muxes.
- [ ] **Shared HDHomeRun** — Tvheadend marks a mux FAIL at once when a tuner's lock is held by
      another client (`failed to acquire lockkey`), rather than trying another tuner. Options: give each
      server its own tuners; point the other server's playlist at specific tuners; or patch Tvheadend to
      return "no free adapter" so the scan requeues.

## Housekeeping

- [ ] Test every screen against the real server (built and tested against mocks so far).
      Try risky changes (stream/codec profiles, users) on a second Tvheadend instance first.
- [ ] nginx: add a `/hdhr/<ip>/` → `http://<ip>/` proxy (private IPs only) for the HDHomeRun tuner check,
      in case the device doesn't allow direct browser requests.
- [ ] Serve the production admin build from nginx on raven1 (`npm run build:admin` →
      `dist/gotvh-admin/browser`) instead of the dev server.
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
