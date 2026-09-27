# GoTVH admin — TODO

Working list for the admin app (`projects/gotvh-admin`). Most-basic first.

## Basics still missing

- [ ] **Recordings**
  - [ ] open one recording to edit title, start/stop, padding
  - [ ] show why a recording failed (errors, file, size)
  - [ ] add a one-off recording by channel + time
  - [ ] time-based timers (`dvr/timerec/*` — calls already in the shared client)
- [ ] **Add a mux by hand** to a network (for regions whose predefined list is missing one).
- [ ] **"Map to channels" on Services** — the stock one-click mapping with defaults, as a
      stopgap until the full screen below.

## Setup without system knowledge

The stock UI needs you to know the chain
`tuner → network → mux → service → (map) → channel → (EPG match) → guide data`.

- [ ] **Map services screen** — services not yet on a channel, grouped by network/mux;
      preview of the channels to create (name, number from the broadcast where available,
      tags), untick radio/data services, catch the same station on two networks and offer
      one channel fed by both; create, then go straight to EPG match.
- [ ] **Linked screens** — a "Connected to" panel in every editor with click-through links
      (channel → service → mux → network → tuner, EPG source; network → mux/service counts,
      services not yet mapped).
- [ ] **Guided "Add a source"** — pick a tuner or paste an IPTV playlist, pick region
      frequencies, scan with progress, map services, match EPG — in one flow built on the
      two items above.

## Housekeeping

- [ ] Test every screen against the real server (built and tested against mocks so far).
      Try risky changes (stream/codec profiles, users) on a second Tvheadend instance first.
- [ ] Merge `admin-workspace` into `main`.
- [ ] Serve the production admin build from nginx on raven1 (`npm run build:admin` →
      `dist/gotvh-admin/browser`) instead of the dev server.
- [ ] Switch the TV app's auto-record screen to the shared helpers in
      `projects/tvh-api/src/autorec-rules.ts`.
- [ ] Upgrade Angular 19 → 21 on its own branch (clears most `npm audit` findings).
- [ ] `npm audit fix` (non-breaking) for build-tool advisories.

## Done

- [x] Admin app scaffold, shared API library, desktop layout
- [x] Live status (tuner signal/SNR/errors with rising-error warning, streams, clients; stop recording, disconnect)
- [x] Dashboard (read-only), Recordings (bulk cancel / delete / watched)
- [x] Auto-record rules (full editor, bulk enable/disable/delete)
- [x] DVR profiles (metadata-driven editor)
- [x] Tuners & networks (tuner tree, networks, muxes, services)
- [x] Channels (filters, EPG source column, bulk edit)
- [x] EPG sources (grabbers, settings incl. cron, EPG channels, map by name)
- [x] Users & access (users joined with passwords, roles, lockout guards, blocked networks)
- [x] Channel tags (channel counts, order, hidden/private, what limits them, link to Channels)
- [x] Stream profiles (types in plain English, used-by, default, codec profiles for transcoding)
- [x] Multi-select + bulk actions + bulk edit (add/remove/replace for lists) everywhere
