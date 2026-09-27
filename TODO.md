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
- [ ] **More Connected to links** — recordings (→ channel → … → tuner), EPG channels
      (→ channels they feed), channel tags (→ their channels).
- [ ] **Guided "Add a source"** — pick a tuner or paste an IPTV playlist, pick region
      frequencies, scan with progress, map services, match EPG — in one flow built on the
      two items above.

## Housekeeping

- [ ] Test every screen against the real server (built and tested against mocks so far).
      Try risky changes (stream/codec profiles, users) on a second Tvheadend instance first.
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
